import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { Session, SessionManager } from './sessionManager';
import { isWindows } from './platform';
import { terminalTracker } from './terminalTracker';

// Default focus request file for cross-window communication
const DEFAULT_FOCUS_REQUEST_FILE = path.join(os.homedir(), '.claude', 'claude-attn', 'focus-request.json');

interface FocusRequest {
    sessionId: string;
    folder: string;
    vscodeIpcHandle?: string;
    timestamp: number;
}

export interface CrossWindowIpcOptions {
    focusRequestFile?: string;
    monitorDir?: string;
}

/**
 * Manages cross-window communication for focusing sessions in other VS Code windows.
 */
export class CrossWindowIpc {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly matchSessionToTerminal: (session: Session, terminals: readonly vscode.Terminal[]) => Promise<vscode.Terminal | undefined>;
    private readonly clearAttentionIfNeeded: (session: Session) => Promise<void>;
    private readonly focusRequestFile: string;

    constructor(
        outputChannel: vscode.OutputChannel,
        matchSessionToTerminal: (session: Session, terminals: readonly vscode.Terminal[]) => Promise<vscode.Terminal | undefined>,
        clearAttentionIfNeeded: (session: Session) => Promise<void>,
        options?: CrossWindowIpcOptions
    ) {
        this.outputChannel = outputChannel;
        this.matchSessionToTerminal = matchSessionToTerminal;
        this.clearAttentionIfNeeded = clearAttentionIfNeeded;
        this.focusRequestFile = options?.focusRequestFile ?? DEFAULT_FOCUS_REQUEST_FILE;
    }

    /**
     * Get the focus request file path.
     */
    getFocusRequestFilePath(): string {
        return this.focusRequestFile;
    }

    /**
     * Handle incoming focus request from another VS Code window.
     */
    async handleIncomingFocusRequest(sessionManager: SessionManager): Promise<void> {
        try {
            if (!fs.existsSync(this.focusRequestFile)) {
                return;
            }

            const content = fs.readFileSync(this.focusRequestFile, 'utf-8');
            const request: FocusRequest = JSON.parse(content);

            // Delete and ignore stale requests (older than 5 seconds)
            if (Date.now() - request.timestamp > 5000) {
                this.outputChannel.appendLine(`Ignoring stale focus request for ${request.folder}`);
                try {
                    fs.unlinkSync(this.focusRequestFile);
                } catch {
                    // Ignore - file may have been already deleted
                }
                return;
            }

            // Check if this request is for us by matching IPC handle
            const myIpcHandle = process.env.VSCODE_GIT_IPC_HANDLE;
            if (request.vscodeIpcHandle && myIpcHandle) {
                if (request.vscodeIpcHandle !== myIpcHandle) {
                    this.outputChannel.appendLine(`Focus request not for this window (IPC mismatch)`);
                    return;
                }
            } else {
                // Fallback to folder matching if no IPC handle
                if (!this.isFolderInCurrentWorkspace(request.folder)) {
                    this.outputChannel.appendLine(`Focus request not for this workspace: ${request.folder}`);
                    return;
                }
            }

            this.outputChannel.appendLine(`Handling focus request for session ${request.sessionId}`);

            // Clear the request file first (we're handling it)
            try {
                fs.unlinkSync(this.focusRequestFile);
            } catch {
                // Ignore - another window might have already handled it
            }

            // Find the session
            const session = sessionManager.getAllSessions().find(s => s.id === request.sessionId);
            if (!session) {
                this.outputChannel.appendLine(`Session not found: ${request.sessionId}`);
                return;
            }

            // Activate our window (bring to foreground)
            if (isWindows) {
                await this.activateCurrentWindow();
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
        } catch (error) {
            this.outputChannel.appendLine(`Error handling focus request: ${error}`);
        }
    }

    /**
     * Switch to the VS Code window for the given session.
     */
    async switchToWindow(session: Session): Promise<boolean> {
        const folderPath = session.cwd!;
        const gitRoot = await this.getGitRoot(folderPath);
        const targetPath = gitRoot || folderPath;
        const folderName = path.basename(targetPath);

        this.outputChannel.appendLine(`switchToVSCodeWindow: session=${session.id}, folder=${folderName}, ipc=${session.vscodeIpcHandle}`);

        // Write focus request with IPC handle
        this.writeFocusRequest(session.id, targetPath, session.vscodeIpcHandle);

        // Try to activate the window from here for faster response
        if (isWindows) {
            const activated = await this.activateWindowByFolder(folderName);
            if (activated) {
                this.outputChannel.appendLine(`Window activated via folder name "${folderName}"`);
                return true;
            }
            this.outputChannel.appendLine(`Folder activation failed, falling back to code command`);
        }

        // Fallback: Find a file to open (this triggers window focus)
        const fileToOpen = await this.findFileToOpen(targetPath);
        if (!fileToOpen) {
            this.outputChannel.appendLine(`No file found to open in ${targetPath}`);
            return false;
        }

        return new Promise((resolve) => {
            const cmd = isWindows
                ? `cmd.exe /c start "" code "${fileToOpen}"`
                : `code "${fileToOpen}"`;

            exec(cmd, { timeout: 5000 }, (error: Error | null) => {
                if (error) {
                    this.outputChannel.appendLine(`code command error: ${error.message}`);
                    resolve(false);
                    return;
                }
                this.outputChannel.appendLine(`Opened file to switch window: ${fileToOpen}`);
                resolve(true);
            });
        });
    }

    /**
     * Check if a session's cwd is within the current workspace folders.
     */
    isSessionInCurrentWorkspace(session: Session): boolean {
        if (!session.cwd) { return false; }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        return workspaceFolders.some(f => session.cwd!.startsWith(f.uri.fsPath));
    }

    private isFolderInCurrentWorkspace(folderPath: string): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        const normalizedFolder = folderPath.replace(/\//g, '\\').toLowerCase();

        for (const f of workspaceFolders) {
            const normalizedWorkspace = f.uri.fsPath.toLowerCase();
            if (normalizedFolder.startsWith(normalizedWorkspace) || normalizedWorkspace.startsWith(normalizedFolder)) {
                return true;
            }
        }
        return false;
    }

    private writeFocusRequest(sessionId: string, folder: string, vscodeIpcHandle?: string): void {
        const request: FocusRequest = {
            sessionId,
            folder,
            vscodeIpcHandle,
            timestamp: Date.now()
        };

        const dir = path.dirname(this.focusRequestFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(this.focusRequestFile, JSON.stringify(request, null, 2));
        this.outputChannel.appendLine(`Wrote focus request for ${sessionId} in ${folder}`);
    }

    private async findFileToOpen(folderPath: string): Promise<string | null> {
        const candidates = ['README.md', 'package.json', '.gitignore', 'Cargo.toml', 'go.mod'];

        for (const candidate of candidates) {
            const filePath = path.join(folderPath, candidate);
            if (fs.existsSync(filePath)) {
                return filePath;
            }
        }

        try {
            const files = fs.readdirSync(folderPath);
            for (const file of files) {
                const filePath = path.join(folderPath, file);
                const stat = fs.statSync(filePath);
                if (stat.isFile() && !file.startsWith('.')) {
                    return filePath;
                }
            }
        } catch {
            // Ignore errors
        }

        return null;
    }

    private async getGitRoot(folderPath: string): Promise<string | null> {
        return new Promise((resolve) => {
            exec(`git -C "${folderPath}" rev-parse --show-toplevel`, (error: Error | null, stdout: string) => {
                if (error) {
                    resolve(null);
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }

    private async activateWindowByFolder(folderName: string): Promise<boolean> {
        if (!isWindows) {
            return false;
        }

        const scriptPath = path.join(os.homedir(), '.claude', 'claude-attn', 'activate-vscode-window.ps1');

        return new Promise((resolve) => {
            const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -FolderName "${folderName}"`;

            exec(cmd, { timeout: 3000 }, (error: Error | null, stdout: string) => {
                if (error) {
                    this.outputChannel.appendLine(`activateWindowByFolder error: ${error.message}`);
                    resolve(false);
                    return;
                }
                const success = stdout.toLowerCase().includes('true');
                this.outputChannel.appendLine(`activateWindowByFolder(${folderName}): ${success}`);
                resolve(success);
            });
        });
    }

    /**
     * Activate the current VS Code window (bring to foreground).
     * Uses the current process ID to find and activate its own window.
     */
    private async activateCurrentWindow(): Promise<boolean> {
        const pid = process.pid;
        this.outputChannel.appendLine(`Activating current window (pid: ${pid})`);

        const scriptPath = path.join(os.homedir(), '.claude', 'claude-attn', 'activate-by-pid.ps1');

        return new Promise((resolve) => {
            const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -ProcessId ${pid}`;

            exec(cmd, { timeout: 3000 }, (error: Error | null, stdout: string) => {
                if (error) {
                    this.outputChannel.appendLine(`activateCurrentWindow error: ${error.message}`);
                    resolve(false);
                    return;
                }
                const success = stdout.toLowerCase().includes('true');
                this.outputChannel.appendLine(`activateCurrentWindow: ${stdout.trim()}`);
                resolve(success);
            });
        });
    }
}
