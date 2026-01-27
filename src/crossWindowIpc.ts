import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { Session, SessionManager } from './sessionManager';
import { terminalTracker } from './terminalTracker';

// Single focus request file - all windows watch this, self-select by workspace match
const FOCUS_REQUEST_FILE = path.join(os.homedir(), '.claude', 'claude-attn', 'focus-request.json');

interface FocusRequest {
    sessionId: string;
    cwd: string;  // Used for workspace matching (fallback)
    vscodeIpcHandle?: string;  // Target window's IPC handle (deprecated, kept for compatibility)
    windowHandle?: string;  // Windows HWND for direct window activation
    timestamp: number;
}

export interface CrossWindowIpcOptions {
    focusRequestFile?: string;
}

/**
 * Manages cross-window communication for focusing sessions in other VS Code windows.
 * Uses a broadcast model: writes to a single file, all windows check if it's for them.
 */
export class CrossWindowIpc implements vscode.Disposable {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly matchSessionToTerminal: (session: Session, terminals: readonly vscode.Terminal[]) => Promise<vscode.Terminal | undefined>;
    private readonly clearAttentionIfNeeded: (session: Session) => Promise<void>;
    private readonly focusRequestFile: string;
    private readonly windowId: string;
    private pollingInterval: NodeJS.Timeout | null = null;
    private lastMtime: number = 0;
    private sessionManager: SessionManager | null = null;
    private _learnedIpcHandle: string | undefined;  // Learned from sessions in our workspace

    /**
     * Get this window's IPC handle.
     * Learned from sessions that belong to this workspace (since extension host doesn't have it).
     */
    private get myIpcHandle(): string | undefined {
        return this._learnedIpcHandle;
    }

    constructor(
        outputChannel: vscode.OutputChannel,
        matchSessionToTerminal: (session: Session, terminals: readonly vscode.Terminal[]) => Promise<vscode.Terminal | undefined>,
        clearAttentionIfNeeded: (session: Session) => Promise<void>,
        options?: CrossWindowIpcOptions
    ) {
        this.outputChannel = outputChannel;
        this.matchSessionToTerminal = matchSessionToTerminal;
        this.clearAttentionIfNeeded = clearAttentionIfNeeded;
        this.focusRequestFile = options?.focusRequestFile ?? FOCUS_REQUEST_FILE;
        this.windowId = vscode.env.sessionId;

        this.outputChannel.appendLine(`CrossWindowIpc initialized with windowId: ${this.windowId}`);
    }

    /**
     * Get the unique window ID for this VS Code window.
     */
    getWindowId(): string {
        return this.windowId;
    }

    /**
     * Learn our IPC handle from sessions that belong to this workspace.
     * Called when sessions are loaded/updated.
     */
    learnIpcHandleFromSessions(sessions: Session[]): void {
        // Find a session that's in our workspace and has an IPC handle
        for (const session of sessions) {
            if (session.vscodeIpcHandle && this.isCwdInCurrentWorkspace(session.cwd ?? '')) {
                if (this._learnedIpcHandle !== session.vscodeIpcHandle) {
                    this._learnedIpcHandle = session.vscodeIpcHandle;
                    this.outputChannel.appendLine(`Learned IPC handle from session ${session.id}: ${this._learnedIpcHandle}`);
                }
                return;  // Found one, no need to check more
            }
        }
    }

    /**
     * Start polling for incoming focus requests.
     */
    startPolling(sessionManager: SessionManager): void {
        this.sessionManager = sessionManager;

        // Ensure directory exists
        const dir = path.dirname(this.focusRequestFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Check for any pending focus request immediately
        this.checkForFocusRequest();

        // Poll every 250ms
        this.pollingInterval = setInterval(() => {
            this.checkForFocusRequest();
        }, 250);

        this.outputChannel.appendLine(`Started polling for focus requests (windowId: ${this.windowId})`);
    }

    /**
     * Stop polling for focus requests.
     */
    stopPolling(): void {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    /**
     * Check for an incoming focus request.
     * All windows check the same file; only the one with matching workspace handles it.
     */
    private checkForFocusRequest(): void {
        try {
            // Check if file exists using stat (also gets mtime for optimization)
            const stat = fs.statSync(this.focusRequestFile);
            const mtime = stat.mtimeMs;

            // Skip if we've already processed this version
            if (mtime === this.lastMtime) {
                return;
            }
            this.lastMtime = mtime;

            // Read the request
            const content = fs.readFileSync(this.focusRequestFile, 'utf-8');
            const request: FocusRequest = JSON.parse(content);

            // Ignore stale requests (older than 5 seconds)
            if (Date.now() - request.timestamp > 5000) {
                this.outputChannel.appendLine(`Ignoring stale focus request for session ${request.sessionId}`);
                return;
            }

            // Check if this request is for us - prefer IPC handle matching (exact), fall back to cwd
            if (request.vscodeIpcHandle && this.myIpcHandle) {
                // IPC handle matching - exact match required
                if (request.vscodeIpcHandle !== this.myIpcHandle) {
                    this.outputChannel.appendLine(`Focus request not for this window (IPC mismatch: ${request.vscodeIpcHandle} vs ${this.myIpcHandle})`);
                    return;
                }
                this.outputChannel.appendLine(`Focus request matched by IPC handle`);
            } else {
                // Fallback: cwd-based workspace matching (for sessions without IPC handle)
                if (!this.isCwdInCurrentWorkspace(request.cwd)) {
                    this.outputChannel.appendLine(`Focus request not for this workspace: ${request.cwd}`);
                    return;
                }
                this.outputChannel.appendLine(`Focus request matched by workspace folder`);
            }

            this.outputChannel.appendLine(`Handling focus request for session ${request.sessionId}`);

            // Delete file immediately (we're handling it)
            try {
                fs.unlinkSync(this.focusRequestFile);
            } catch {
                // Ignore - another window might have already handled it
            }

            this.handleFocusRequest(request);
        } catch {
            // File doesn't exist or can't be read - this is normal, ignore
        }
    }

    /**
     * Check if a cwd path is within the current workspace folders.
     */
    private isCwdInCurrentWorkspace(cwd: string): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        // Normalize for comparison (handle escaped backslashes from JSON)
        const normalizedCwd = cwd.replace(/\\\\/g, '\\').toLowerCase();

        return workspaceFolders.some(f => {
            const folderPath = f.uri.fsPath.toLowerCase();
            return normalizedCwd.startsWith(folderPath) || folderPath.startsWith(normalizedCwd);
        });
    }

    /**
     * Handle an incoming focus request.
     */
    private async handleFocusRequest(request: FocusRequest): Promise<void> {
        if (!this.sessionManager) {
            return;
        }

        // Find the session
        const session = this.sessionManager.getAllSessions().find(s => s.id === request.sessionId);
        if (!session) {
            this.outputChannel.appendLine(`Session not found: ${request.sessionId}`);
            return;
        }

        // Bring this window to foreground (Windows only)
        if (process.platform === 'win32') {
            await this.bringThisWindowToForeground();
        }

        // Focus the terminal for this session
        const terminals = vscode.window.terminals;
        if (terminals.length === 0) {
            return;
        }

        // Try terminal matching
        const matched = await this.matchSessionToTerminal(session, terminals);
        if (matched) {
            terminalTracker.associate(session.id, matched);
            this.outputChannel.appendLine(`Focus request: matched terminal "${matched.name}"`);
            matched.show(false);
            await vscode.commands.executeCommand('workbench.action.terminal.focus');
            await this.clearAttentionIfNeeded(session);
        } else if (terminals.length === 1) {
            terminals[0].show(false);
            await vscode.commands.executeCommand('workbench.action.terminal.focus');
            await this.clearAttentionIfNeeded(session);
        }
    }

    /**
     * Bring a VS Code window to foreground by its window handle (Windows only).
     */
    private async bringWindowToForegroundByHandle(windowHandle: string): Promise<boolean> {
        const scriptPath = path.join(os.homedir(), '.claude', 'claude-attn', 'activate-by-handle.ps1');
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -Handle ${windowHandle}`;

        return new Promise((resolve) => {
            exec(cmd, { timeout: 3000 }, (error, stdout) => {
                if (error) {
                    this.outputChannel.appendLine(`bringWindowToForegroundByHandle error: ${error.message}`);
                    resolve(false);
                } else {
                    const result = stdout.trim();
                    this.outputChannel.appendLine(`bringWindowToForegroundByHandle: ${result}`);
                    resolve(result.startsWith('OK'));
                }
            });
        });
    }

    /**
     * Bring this VS Code window to foreground by finding parent Code.exe process (Windows only).
     * Used as a fallback when no window handle is available.
     */
    private async bringThisWindowToForeground(): Promise<void> {
        const scriptPath = path.join(os.homedir(), '.claude', 'claude-attn', 'activate-by-pid.ps1');
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -ExtHostPid ${process.pid}`;

        return new Promise((resolve) => {
            exec(cmd, { timeout: 3000 }, (error, stdout) => {
                if (error) {
                    this.outputChannel.appendLine(`bringThisWindowToForeground error: ${error.message}`);
                } else {
                    this.outputChannel.appendLine(`bringThisWindowToForeground: ${stdout.trim()}`);
                }
                resolve();
            });
        });
    }

    /**
     * Activate a VS Code window by folder name using PowerShell (Windows only).
     * Uses EnumWindows + AttachThreadInput + SetForegroundWindow for robust activation.
     */
    private async activateWindowByFolder(folderName: string): Promise<boolean> {
        const scriptPath = path.join(os.homedir(), '.claude', 'claude-attn', 'activate-window.ps1');

        return new Promise((resolve) => {
            const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -FolderName "${folderName}"`;
            exec(cmd, { timeout: 3000 }, (error, stdout) => {
                if (error) {
                    this.outputChannel.appendLine(`activateWindowByFolder error: ${error.message}`);
                    resolve(false);
                    return;
                }
                const success = stdout.toLowerCase().includes('true');
                this.outputChannel.appendLine(`activateWindowByFolder result: ${stdout.trim()}`);
                resolve(success);
            });
        });
    }

    /**
     * Switch to the VS Code window for the given session.
     */
    async switchToWindow(session: Session): Promise<boolean> {
        const folderPath = session.cwd!;
        const folderName = path.basename(folderPath);

        this.outputChannel.appendLine(`switchToWindow: session=${session.id}, cwd=${folderPath}, windowHandle=${session.windowHandle ?? 'none'}`);

        // Write focus request for cross-window IPC
        this.writeFocusRequest(session.id, folderPath, session.vscodeIpcHandle, session.windowHandle);

        // Windows: Use window handle for direct, reliable activation
        if (process.platform === 'win32' && session.windowHandle) {
            const activated = await this.bringWindowToForegroundByHandle(session.windowHandle);
            if (activated) {
                this.outputChannel.appendLine(`Window activated via handle ${session.windowHandle}`);
                return true;
            }
            this.outputChannel.appendLine(`Window handle activation failed (handle may be stale), trying folder name`);
        }

        // Windows fallback: Try folder name matching (less reliable but doesn't require handle)
        if (process.platform === 'win32') {
            const activated = await this.activateWindowByFolder(folderName);
            if (activated) {
                this.outputChannel.appendLine(`Window activated via folder name "${folderName}"`);
                return true;
            }
            this.outputChannel.appendLine(`PowerShell activation failed, falling back to code command`);
        }

        // // COMMENTED OUT: VS Code URI protocol (has issues on Windows)
        // try {
        //     const fileUri = vscode.Uri.file(folderPath);
        //     const vscodeUri = vscode.Uri.parse(`vscode://file${fileUri.path}`);
        //     this.outputChannel.appendLine(`Trying VS Code URI: ${vscodeUri.toString()}`);
        //     const opened = await vscode.env.openExternal(vscodeUri);
        //     if (opened) {
        //         this.outputChannel.appendLine(`Window activated via VS Code URI protocol`);
        //         return true;
        //     }
        // } catch (error) {
        //     this.outputChannel.appendLine(`VS Code URI protocol error: ${error}`);
        // }

        // Fallback: Spawn detached process to run code command
        // This creates a truly independent process that behaves like running from external terminal
        if (process.platform === 'win32') {
            const child = spawn('cmd.exe', ['/c', 'code', folderPath], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            });
            child.unref();
        } else {
            const child = spawn('code', [folderPath], {
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
        }

        this.outputChannel.appendLine(`Spawned detached code process for: ${folderPath}`);
        return true;
    }

    /**
     * Check if a session's cwd is within the current workspace folders.
     */
    isSessionInCurrentWorkspace(session: Session): boolean {
        if (!session.cwd) { return false; }
        return this.isCwdInCurrentWorkspace(session.cwd);
    }

    /**
     * Check if a session belongs to this window.
     * Uses IPC handle matching (exact) if available, falls back to workspace folder matching.
     */
    isSessionInCurrentWindow(session: Session): boolean {
        // Prefer IPC handle matching - exact and reliable
        if (session.vscodeIpcHandle && this.myIpcHandle) {
            return session.vscodeIpcHandle === this.myIpcHandle;
        }
        // Fallback to workspace folder matching
        return this.isSessionInCurrentWorkspace(session);
    }

    private writeFocusRequest(sessionId: string, cwd: string, vscodeIpcHandle?: string, windowHandle?: string): void {
        const request: FocusRequest = {
            sessionId,
            cwd,
            vscodeIpcHandle,
            windowHandle,
            timestamp: Date.now()
        };

        const dir = path.dirname(this.focusRequestFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(this.focusRequestFile, JSON.stringify(request, null, 2));
        this.outputChannel.appendLine(`Wrote focus request to ${this.focusRequestFile} (ipcHandle: ${vscodeIpcHandle ?? 'none'})`);
    }

    dispose(): void {
        this.stopPolling();
    }
}
