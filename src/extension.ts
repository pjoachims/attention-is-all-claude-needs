import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager, Session } from './sessionManager';
import { FileWatcher } from './fileWatcher';
import { SessionTreeProvider } from './views/sessionTreeView';
import { SessionCleaner } from './sessionCleaner';
import { aliasManager } from './aliasManager';
import { terminalTracker } from './terminalTracker';

let outputChannel: vscode.OutputChannel;
let globalSessionManager: SessionManager;

// Focus request file for cross-window communication
const FOCUS_REQUEST_FILE = path.join(os.homedir(), '.claude', 'attention-monitor', 'focus-request.json');

interface FocusRequest {
    sessionId: string;
    folder: string;
    timestamp: number;
}

// Status bar items (order: claude, attention, idle, running from left to right)
let sbClaude: vscode.StatusBarItem;
let sbAttention: vscode.StatusBarItem;
let sbIdle: vscode.StatusBarItem;
let sbRunning: vscode.StatusBarItem;

// Track recently opened terminals for auto-association
let recentTerminal: { terminal: vscode.Terminal; timestamp: number } | null = null;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Claude Monitor');
    outputChannel.appendLine('Claude Code Attention Monitor activated');

    const sessionManager = new SessionManager();
    globalSessionManager = sessionManager;
    const fileWatcher = new FileWatcher(sessionManager.getSessionsFilePath());
    const treeProvider = new SessionTreeProvider(sessionManager);

    // Create status bar items (priority determines order, higher = more left)
    // Order: claude, attention, idle, running
    sbClaude = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 104);
    sbClaude.command = 'claude-monitor.manageAssociations';
    sbClaude.text = '$(hubot)';
    sbClaude.tooltip = 'Claude Sessions';
    sbClaude.show();

    sbAttention = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
    sbAttention.command = 'claude-monitor.clickAttention';
    sbAttention.show();

    sbIdle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    sbIdle.command = 'claude-monitor.clickIdle';
    sbIdle.show();

    sbRunning = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    sbRunning.command = 'claude-monitor.clickRunning';
    sbRunning.show();

    updateStatusBar(sessionManager);

    // Update status bar when sessions change
    sessionManager.onDidChange(() => {
        updateStatusBar(sessionManager);

        // Clean up ended sessions
        const currentIds = new Set(sessionManager.getAllSessions().map(s => s.id));
        for (const sessionId of terminalTracker.getAssociatedSessionIds()) {
            if (!currentIds.has(sessionId)) {
                terminalTracker.removeSession(sessionId);
                outputChannel.appendLine(`Session ended, removed association for ${sessionId}`);
            }
        }
    });

    // Track when terminals open
    const terminalOpenListener = vscode.window.onDidOpenTerminal((terminal) => {
        outputChannel.appendLine(`Terminal opened: ${terminal.name}`);
        recentTerminal = { terminal, timestamp: Date.now() };
    });

    // Clean up when terminals close
    const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
        const sessionId = terminalTracker.getSessionForTerminal(terminal);
        if (sessionId) {
            outputChannel.appendLine(`Terminal closed, removed association for session ${sessionId}`);
        }
        terminalTracker.removeTerminal(terminal);
        if (recentTerminal?.terminal === terminal) {
            recentTerminal = null;
        }
    });

    context.subscriptions.push(terminalOpenListener, terminalCloseListener);

    const treeView = vscode.window.createTreeView('claudeSessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    fileWatcher.onDidChange(async () => {
        outputChannel.appendLine('Sessions file changed, reloading...');
        await sessionManager.loadSessions();
    });

    fileWatcher.start();
    sessionManager.loadSessions();

    // Watch for cross-window focus requests
    const focusRequestWatcher = new FileWatcher(FOCUS_REQUEST_FILE);
    focusRequestWatcher.onDidChange(async () => {
        await handleIncomingFocusRequest(sessionManager);
    });
    focusRequestWatcher.start();
    context.subscriptions.push(focusRequestWatcher);

    // Load session aliases
    aliasManager.load().then(() => {
        outputChannel.appendLine(`Loaded ${aliasManager.getCount()} session aliases`);
    });

    // Register commands
    const refreshCommand = vscode.commands.registerCommand('claude-monitor.refresh', async () => {
        outputChannel.appendLine('Manual refresh triggered');
        await sessionManager.loadSessions();
        treeProvider.refresh();
    });

    const focusSessionCommand = vscode.commands.registerCommand(
        'claude-monitor.focusSession',
        async (session: Session) => {
            outputChannel.appendLine(`Focusing session: ${session.id}`);
            await focusTerminalForSession(session);
        }
    );

    const manageAssociationsCommand = vscode.commands.registerCommand(
        'claude-monitor.manageAssociations',
        async () => {
            await handleManageAssociations(sessionManager);
        }
    );

    const clickAttentionCommand = vscode.commands.registerCommand(
        'claude-monitor.clickAttention',
        async () => {
            await handleCategoryClick(sessionManager, 'attention');
        }
    );

    const clickRunningCommand = vscode.commands.registerCommand(
        'claude-monitor.clickRunning',
        async () => {
            await handleCategoryClick(sessionManager, 'running');
        }
    );

    const clickIdleCommand = vscode.commands.registerCommand(
        'claude-monitor.clickIdle',
        async () => {
            await handleCategoryClick(sessionManager, 'idle');
        }
    );

    const setupHooksCommand = vscode.commands.registerCommand(
        'claude-monitor.setupHooks',
        async () => {
            await setupClaudeHooks(context);
        }
    );

    // Initialize session cleaner
    const sessionCleaner = new SessionCleaner(sessionManager);

    // Run cleanup immediately on activation to clear any dead sessions
    sessionCleaner.cleanupNow().then(result => {
        if (result.removedCount > 0) {
            outputChannel.appendLine(`Cleaned up ${result.removedCount} dead session(s): ${result.removedIds.join(', ')}`);
        }
    });

    // Start periodic cleanup
    sessionCleaner.start();

    const cleanupCommand = vscode.commands.registerCommand(
        'claude-monitor.cleanupStaleSessions',
        async () => {
            outputChannel.appendLine('Manual cleanup triggered');
            const result = await sessionCleaner.cleanupNow();
            if (result.removedCount > 0) {
                vscode.window.showInformationMessage(
                    `Cleaned up ${result.removedCount} stale session(s)`
                );
                outputChannel.appendLine(`Removed sessions: ${result.removedIds.join(', ')}`);
            } else {
                vscode.window.showInformationMessage('No stale sessions found');
            }
        }
    );

    const renameSessionCommand = vscode.commands.registerCommand(
        'claude-monitor.renameSession',
        async (item?: unknown) => {
            // Handle both tree view context (SessionItem) and direct session argument
            let session: Session | undefined;
            if (item && typeof item === 'object' && 'session' in item) {
                session = (item as { session?: Session }).session;
            } else if (item && typeof item === 'object' && 'id' in item && 'status' in item) {
                session = item as Session;
            }

            // If not called from tree view context, show picker
            if (!session) {
                const sessions = sessionManager.getAllSessions();
                if (sessions.length === 0) {
                    vscode.window.showInformationMessage('No sessions to rename');
                    return;
                }

                const items = sessions.map(s => ({
                    label: getSessionLabel(s),
                    description: s.cwd,
                    session: s
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select a session to rename'
                });

                if (!selected) { return; }
                session = selected.session;
            }

            if (!session.cwd) {
                vscode.window.showWarningMessage('Cannot rename session without a working directory');
                return;
            }

            const currentName = getSessionLabel(session);
            const newName = await vscode.window.showInputBox({
                prompt: 'Enter a new name for this session',
                value: currentName,
                placeHolder: 'e.g., backend-api, frontend, data-pipeline'
            });

            if (newName && newName !== currentName) {
                aliasManager.set(session.cwd, newName);
                await aliasManager.save();
                treeProvider.refresh();
                vscode.window.showInformationMessage(`Session renamed to "${newName}"`);
                outputChannel.appendLine(`Renamed session at ${session.cwd} to "${newName}"`);
            }
        }
    );

    context.subscriptions.push(
        outputChannel,
        sbClaude,
        sbAttention,
        sbIdle,
        sbRunning,
        sessionManager,
        fileWatcher,
        treeView,
        refreshCommand,
        focusSessionCommand,
        manageAssociationsCommand,
        clickAttentionCommand,
        clickRunningCommand,
        clickIdleCommand,
        setupHooksCommand,
        sessionCleaner,
        cleanupCommand,
        renameSessionCommand
    );

    checkHooksSetup(context);
}

/**
 * Get sessions filtered by workspace if globalMode is disabled.
 * In workspace mode, only returns sessions whose cwd is within any workspace folder.
 */
function getFilteredSessions(sessionManager: SessionManager): Session[] {
    const allSessions = sessionManager.getAllSessions();
    const globalMode = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('globalMode', false);

    if (globalMode) {
        return allSessions;
    }

    // Filter to sessions within current workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return allSessions; // No workspace, show all
    }

    const workspacePaths = workspaceFolders.map(f => f.uri.fsPath);
    return allSessions.filter(session => {
        if (!session.cwd) { return false; }
        return workspacePaths.some(wp => session.cwd!.startsWith(wp));
    });
}

function updateStatusBar(sessionManager: SessionManager): void {
    const sessions = getFilteredSessions(sessionManager);
    const attention = sessions.filter(s => s.status === 'attention').length;
    const idle = sessions.filter(s => s.status === 'idle').length;
    const running = sessions.filter(s => s.status === 'running').length;

    const globalMode = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('globalMode', false);
    const modeText = globalMode ? 'Global' : 'Workspace';

    // Attention indicator
    sbAttention.text = `$(bell-dot) ${attention}`;
    sbAttention.tooltip = `${attention} session(s) need attention (${modeText})`;
    if (attention > 0) {
        sbAttention.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        sbAttention.backgroundColor = undefined;
    }

    // Idle indicator
    sbIdle.text = `$(clock) ${idle}`;
    sbIdle.tooltip = `${idle} session(s) idle (${modeText})`;
    sbIdle.backgroundColor = undefined;

    // Running indicator
    sbRunning.text = `$(play) ${running}`;
    sbRunning.tooltip = `${running} session(s) running (${modeText})`;
    sbRunning.backgroundColor = undefined;
}

async function handleManageAssociations(sessionManager: SessionManager): Promise<void> {
    const sessions = getFilteredSessions(sessionManager);
    const globalMode = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('globalMode', false);

    // Group by status
    const attention = sessions.filter(s => s.status === 'attention');
    const running = sessions.filter(s => s.status === 'running');
    const idle = sessions.filter(s => s.status === 'idle');

    // Build quick pick items
    type PickItem = vscode.QuickPickItem & { session?: Session; action?: string };
    const items: PickItem[] = [];

    // Add attention sessions
    if (attention.length > 0) {
        items.push({ label: 'Attention', kind: vscode.QuickPickItemKind.Separator });
        for (const s of attention) {
            items.push({
                label: `$(bell-dot) ${getSessionLabel(s)}`,
                description: s.reason?.replace(/_/g, ' '),
                detail: s.cwd,
                session: s
            });
        }
    }

    // Add running sessions
    if (running.length > 0) {
        items.push({ label: 'Running', kind: vscode.QuickPickItemKind.Separator });
        for (const s of running) {
            items.push({
                label: `$(play) ${getSessionLabel(s)}`,
                detail: s.cwd,
                session: s
            });
        }
    }

    // Add idle sessions
    if (idle.length > 0) {
        items.push({ label: 'Idle', kind: vscode.QuickPickItemKind.Separator });
        for (const s of idle) {
            items.push({
                label: `$(clock) ${getSessionLabel(s)}`,
                detail: s.cwd,
                session: s
            });
        }
    }

    // Add settings separator and options
    items.push({ label: 'Settings', kind: vscode.QuickPickItemKind.Separator });

    const modeLabel = globalMode ? 'Global' : 'Workspace';
    const modeToggle = globalMode ? 'Workspace only' : 'Global (all windows)';
    items.push({
        label: `$(settings-gear) Mode: ${modeLabel}`,
        description: `Switch to ${modeToggle}`,
        action: 'toggleMode'
    });

    items.push({
        label: '$(trash) Cleanup stale sessions',
        description: 'Remove dead sessions',
        action: 'cleanup'
    });

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: sessions.length > 0
            ? (globalMode ? 'Select session (will switch window if needed)' : 'Select session')
            : 'No sessions - configure settings'
    });

    if (!selected) { return; }

    // Handle settings actions
    if (selected.action === 'toggleMode') {
        const config = vscode.workspace.getConfiguration('claudeMonitor');
        await config.update('globalMode', !globalMode, vscode.ConfigurationTarget.Global);
        const newMode = !globalMode ? 'Global' : 'Workspace';
        vscode.window.showInformationMessage(`Claude Monitor: Switched to ${newMode} mode`);
        updateStatusBar(sessionManager);
        return;
    }

    if (selected.action === 'cleanup') {
        await vscode.commands.executeCommand('claude-monitor.cleanupStaleSessions');
        return;
    }

    // Focus session
    if (selected.session) {
        await focusTerminalForSession(selected.session);
    }
}

async function handleCategoryClick(
    sessionManager: SessionManager,
    category: 'attention' | 'running' | 'idle'
): Promise<void> {
    const filtered = getFilteredSessions(sessionManager);
    let sessions: Session[];
    let icon: string;
    let label: string;

    switch (category) {
        case 'attention':
            sessions = filtered.filter(s => s.status === 'attention');
            icon = '$(bell-dot)';
            label = 'Attention Required';
            break;
        case 'running':
            sessions = filtered.filter(s => s.status === 'running');
            icon = '$(play)';
            label = 'Running';
            break;
        case 'idle':
            sessions = filtered.filter(s => s.status === 'idle');
            icon = '$(clock)';
            label = 'Idle';
            break;
    }

    if (sessions.length === 0) {
        vscode.window.showInformationMessage(`No ${label.toLowerCase()} sessions`);
        return;
    }

    // If only 1, go directly
    if (sessions.length === 1) {
        await focusTerminalForSession(sessions[0]);
        return;
    }

    // Multiple - show picker
    const items = sessions.map(s => ({
        label: `${icon} ${getSessionLabel(s)}`,
        description: s.reason?.replace(/_/g, ' '),
        session: s
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select a ${label.toLowerCase()} session`
    });

    if (selected) {
        await focusTerminalForSession(selected.session);
    }
}

function getSessionLabel(session: Session): string {
    return getSessionDisplayName(session);
}

async function focusTerminalForSession(session: Session): Promise<void> {
    const globalMode = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('globalMode', false);

    // In global mode, check if we need to switch VS Code windows
    if (globalMode && session.cwd) {
        const isInCurrentWorkspace = isSessionInCurrentWorkspace(session);
        if (!isInCurrentWorkspace) {
            // Try to switch to the correct VS Code window
            const switched = await switchToVSCodeWindow(session.cwd, session.id);
            if (switched) {
                outputChannel.appendLine(`Switched to VS Code window for ${session.cwd}`);
                // The other window will handle terminal focus via focus request
                return;
            } else {
                outputChannel.appendLine(`Could not switch to VS Code window for ${session.cwd}`);
                // Fall through to try terminal focus in current window anyway
            }
        }
    }

    const terminals = vscode.window.terminals;

    if (terminals.length === 0) {
        vscode.window.showInformationMessage('No terminals open');
        return;
    }

    // Check if we already have an association
    const existingTerminal = terminalTracker.getTerminalForSession(session.id);
    if (existingTerminal) {
        existingTerminal.show();
        await clearAttentionIfNeeded(session);
        return;
    }

    // Try PID-based matching by walking up the process tree
    const matched = await matchSessionToTerminal(session, terminals);
    if (matched) {
        terminalTracker.associate(session.id, matched);
        outputChannel.appendLine(`PID match: session ${session.id} → terminal "${matched.name}"`);
        matched.show();
        await clearAttentionIfNeeded(session);
        return;
    }

    // Only one terminal - associate and use it
    if (terminals.length === 1) {
        terminalTracker.associate(session.id, terminals[0]);
        outputChannel.appendLine(`Auto-associated session ${session.id} with only terminal ${terminals[0].name}`);
        terminals[0].show();
        await clearAttentionIfNeeded(session);
        return;
    }

    // Multiple terminals, no PID match - show picker
    const cwdBasename = session.cwd ? path.basename(session.cwd) : '';
    const items = terminals.map((t, i) => ({
        label: t.name,
        description: `Terminal ${i + 1}`,
        terminal: t
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Select terminal for "${cwdBasename || session.id}"`
    });

    if (selected) {
        terminalTracker.associate(session.id, selected.terminal);
        outputChannel.appendLine(`User selected terminal ${selected.terminal.name} for session ${session.id}`);
        selected.terminal.show();
        await clearAttentionIfNeeded(session);
    }
}

/**
 * Clear attention status when user focuses the terminal.
 */
async function clearAttentionIfNeeded(session: Session): Promise<void> {
    if (session.status === 'attention') {
        outputChannel.appendLine(`Clearing attention for session ${session.id}`);
        await globalSessionManager.updateSessionStatus(session.id, 'running');
    }
}

/**
 * Match a session to a terminal by walking up the process tree.
 * Returns the matching terminal or undefined.
 */
async function matchSessionToTerminal(
    session: Session,
    terminals: readonly vscode.Terminal[]
): Promise<vscode.Terminal | undefined> {
    const claudePid = extractPidFromSessionId(session.id);
    if (claudePid === null) {
        return undefined;
    }

    // Get all terminal PIDs
    const terminalPids = new Map<number, vscode.Terminal>();
    for (const terminal of terminals) {
        try {
            const pid = await terminal.processId;
            if (pid !== undefined) {
                terminalPids.set(pid, terminal);
            }
        } catch {
            // Terminal might have closed
        }
    }

    // Walk up the process tree from Claude's PID
    let currentPid: number | null = claudePid;
    const maxDepth = 10; // Prevent infinite loops
    for (let i = 0; i < maxDepth && currentPid !== null && currentPid > 1; i++) {
        const terminal = terminalPids.get(currentPid);
        if (terminal) {
            return terminal;
        }
        currentPid = await getParentPid(currentPid);
    }

    return undefined;
}

/**
 * Get the display name for a session (alias or derived name)
 */
function getSessionDisplayName(session: Session): string {
    // First check for user-defined alias (keyed by cwd)
    if (session.cwd) {
        const alias = aliasManager.get(session.cwd);
        if (alias) {
            return alias;
        }
        // Fall back to directory basename
        return path.basename(session.cwd);
    }

    // Last resort: truncated session ID
    return session.id.substring(0, 8);
}


/**
 * Extract PID from session ID (format: "ppid-12345")
 */
function extractPidFromSessionId(sessionId: string): number | null {
    const match = sessionId.match(/^ppid-(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Get the parent PID of a process. Returns null if not found.
 * Works on macOS, Linux, and Windows.
 */
async function getParentPid(pid: number): Promise<number | null> {
    return new Promise((resolve) => {
        const { exec } = require('child_process');

        if (process.platform === 'win32') {
            // Windows: use WMIC or PowerShell
            exec(`wmic process where processid=${pid} get parentprocessid /format:value`, (error: Error | null, stdout: string) => {
                if (error) {
                    // Fallback to PowerShell
                    exec(`powershell -Command "(Get-Process -Id ${pid}).Parent.Id"`, (psError: Error | null, psStdout: string) => {
                        if (psError) {
                            resolve(null);
                            return;
                        }
                        const ppid = parseInt(psStdout.trim(), 10);
                        resolve(isNaN(ppid) ? null : ppid);
                    });
                    return;
                }
                // Parse "ParentProcessId=1234"
                const match = stdout.match(/ParentProcessId=(\d+)/);
                resolve(match ? parseInt(match[1], 10) : null);
            });
        } else {
            // macOS / Linux: use ps
            exec(`ps -o ppid= -p ${pid}`, (error: Error | null, stdout: string) => {
                if (error) {
                    resolve(null);
                    return;
                }
                const ppid = parseInt(stdout.trim(), 10);
                resolve(isNaN(ppid) ? null : ppid);
            });
        }
    });
}

/**
 * Check if a session's cwd is within the current workspace folders.
 */
function isSessionInCurrentWorkspace(session: Session): boolean {
    if (!session.cwd) { return false; }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return false;
    }

    return workspaceFolders.some(f => session.cwd!.startsWith(f.uri.fsPath));
}

/**
 * Check if a folder path is within the current workspace folders.
 */
function isFolderInCurrentWorkspace(folderPath: string): boolean {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return false;
    }

    return workspaceFolders.some(f =>
        folderPath.startsWith(f.uri.fsPath) || f.uri.fsPath.startsWith(folderPath)
    );
}

/**
 * Handle incoming focus request from another VS Code window.
 */
async function handleIncomingFocusRequest(sessionManager: SessionManager): Promise<void> {
    try {
        if (!fs.existsSync(FOCUS_REQUEST_FILE)) {
            return;
        }

        const content = fs.readFileSync(FOCUS_REQUEST_FILE, 'utf-8');
        const request: FocusRequest = JSON.parse(content);

        // Ignore stale requests (older than 5 seconds)
        if (Date.now() - request.timestamp > 5000) {
            outputChannel.appendLine(`Ignoring stale focus request for ${request.folder}`);
            return;
        }

        // Check if this folder belongs to our workspace
        if (!isFolderInCurrentWorkspace(request.folder)) {
            outputChannel.appendLine(`Focus request not for this workspace: ${request.folder}`);
            return;
        }

        outputChannel.appendLine(`Handling focus request for session ${request.sessionId} in ${request.folder}`);

        // Find the session
        const session = sessionManager.getAllSessions().find(s => s.id === request.sessionId);
        if (!session) {
            outputChannel.appendLine(`Session not found: ${request.sessionId}`);
            return;
        }

        // Focus this window
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');

        // Focus the terminal for this session
        const terminals = vscode.window.terminals;
        if (terminals.length === 0) {
            return;
        }

        // Try PID matching
        const matched = await matchSessionToTerminal(session, terminals);
        if (matched) {
            terminalTracker.associate(session.id, matched);
            outputChannel.appendLine(`Focus request: PID match → terminal "${matched.name}"`);
            matched.show();
            await clearAttentionIfNeeded(session);
        } else if (terminals.length === 1) {
            terminals[0].show();
            await clearAttentionIfNeeded(session);
        }

        // Clear the request file
        fs.unlinkSync(FOCUS_REQUEST_FILE);
    } catch (error) {
        outputChannel.appendLine(`Error handling focus request: ${error}`);
    }
}

/**
 * Write a focus request for another window to pick up.
 */
function writeFocusRequest(sessionId: string, folder: string): void {
    const request: FocusRequest = {
        sessionId,
        folder,
        timestamp: Date.now()
    };

    const dir = path.dirname(FOCUS_REQUEST_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(FOCUS_REQUEST_FILE, JSON.stringify(request, null, 2));
    outputChannel.appendLine(`Wrote focus request for ${sessionId} in ${folder}`);
}

/**
 * Find a file to open in the target folder (for window switching).
 */
async function findFileToOpen(folderPath: string): Promise<string | null> {
    const candidates = ['README.md', 'package.json', '.gitignore', 'Cargo.toml', 'go.mod'];

    for (const candidate of candidates) {
        const filePath = path.join(folderPath, candidate);
        if (fs.existsSync(filePath)) {
            return filePath;
        }
    }

    // Try to find any file
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

/**
 * Get the git root directory for a path.
 */
async function getGitRoot(folderPath: string): Promise<string | null> {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        exec(`git -C "${folderPath}" rev-parse --show-toplevel`, (error: Error | null, stdout: string) => {
            if (error) {
                resolve(null);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Switch to the VS Code window that has the given folder open.
 * Uses git root to find the actual workspace folder, writes a focus request,
 * then opens a file to trigger the window switch.
 */
async function switchToVSCodeWindow(folderPath: string, sessionId: string): Promise<boolean> {
    // First try to find the git root - this is likely the workspace folder
    const gitRoot = await getGitRoot(folderPath);
    const targetPath = gitRoot || folderPath;

    outputChannel.appendLine(`switchToVSCodeWindow: cwd=${folderPath}, gitRoot=${gitRoot}, using=${targetPath}`);

    // Write focus request so the target window knows to focus the terminal
    writeFocusRequest(sessionId, targetPath);

    // Find a file to open (this triggers window focus)
    const fileToOpen = await findFileToOpen(targetPath);
    if (!fileToOpen) {
        outputChannel.appendLine(`No file found to open in ${targetPath}`);
        return false;
    }

    return new Promise((resolve) => {
        const { exec } = require('child_process');

        // Open the file - this focuses the window that has it
        exec(`code "${fileToOpen}"`, (error: Error | null) => {
            if (error) {
                outputChannel.appendLine(`code command error: ${error.message}`);
                resolve(false);
                return;
            }
            outputChannel.appendLine(`Opened file to switch window: ${fileToOpen}`);
            resolve(true);
        });
    });
}

async function checkHooksSetup(context: vscode.ExtensionContext): Promise<void> {
    const hasSetupHooks = context.globalState.get<boolean>('hasSetupHooks', false);

    if (!hasSetupHooks) {
        const result = await vscode.window.showInformationMessage(
            'Claude Code Attention Monitor needs to configure hooks. Would you like to set them up now?',
            'Setup Hooks',
            'Later',
            "Don't Ask Again"
        );

        if (result === 'Setup Hooks') {
            await setupClaudeHooks(context);
        } else if (result === "Don't Ask Again") {
            await context.globalState.update('hasSetupHooks', true);
        }
    }
}

async function setupClaudeHooks(context: vscode.ExtensionContext): Promise<void> {
    const claudeDir = path.join(os.homedir(), '.claude');
    const monitorDir = path.join(claudeDir, 'attention-monitor');
    const settingsPath = path.join(claudeDir, 'settings.json');
    const notifyScriptPath = path.join(monitorDir, 'notify.sh');

    try {
        if (!fs.existsSync(monitorDir)) {
            fs.mkdirSync(monitorDir, { recursive: true });
        }

        const notifyScript = getNotifyScript();
        fs.writeFileSync(notifyScriptPath, notifyScript, { mode: 0o755 });

        let settings: Record<string, unknown> = {};
        if (fs.existsSync(settingsPath)) {
            const content = fs.readFileSync(settingsPath, 'utf-8');
            settings = JSON.parse(content);
        }

        const hooks = getHooksConfig(notifyScriptPath);
        settings['hooks'] = mergeHooks(settings['hooks'] as Record<string, unknown> || {}, hooks);

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

        await context.globalState.update('hasSetupHooks', true);

        vscode.window.showInformationMessage(
            'Claude Code hooks configured successfully! Restart any running Claude Code sessions for changes to take effect.'
        );

        outputChannel.appendLine('Hooks setup completed');
        outputChannel.appendLine(`Notify script: ${notifyScriptPath}`);
        outputChannel.appendLine(`Settings file: ${settingsPath}`);
    } catch (error) {
        outputChannel.appendLine(`Error setting up hooks: ${error}`);
        vscode.window.showErrorMessage(
            `Failed to setup hooks: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
}

function getNotifyScript(): string {
    return `#!/bin/bash
# Claude Code Attention Monitor - Hook Script

ACTION="$1"
SESSION_ID="\${CLAUDE_SESSION_ID:-ppid-\$PPID}"
CWD="\${CLAUDE_WORKING_DIRECTORY:-\$(pwd)}"
SESSIONS_FILE=~/.claude/attention-monitor/sessions.json
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Ensure directory exists
mkdir -p "$(dirname "$SESSIONS_FILE")"

# Initialize file if it doesn't exist
if [ ! -f "$SESSIONS_FILE" ]; then
    echo '{"sessions":{}}' > "$SESSIONS_FILE"
fi

# Function to update session
update_session() {
    local status="$1"
    local reason="$2"

    # Use Node.js for reliable JSON manipulation (available if Claude Code is installed)
    node -e "
        const fs = require('fs');
        const path = '$SESSIONS_FILE';
        let data = { sessions: {} };
        try {
            data = JSON.parse(fs.readFileSync(path, 'utf-8'));
        } catch (e) {}

        if ('$status' === 'ended') {
            delete data.sessions['$SESSION_ID'];
        } else {
            data.sessions['$SESSION_ID'] = {
                id: '$SESSION_ID',
                status: '$status',
                reason: '$reason' || undefined,
                cwd: '$CWD',
                lastUpdate: '$TIMESTAMP'
            };
        }

        fs.writeFileSync(path, JSON.stringify(data, null, 2));
    " 2>/dev/null || {
        # Fallback: simple file write (less reliable for concurrent access)
        echo '{"sessions":{"'$SESSION_ID'":{"id":"'$SESSION_ID'","status":"'$status'","cwd":"'$CWD'","lastUpdate":"'$TIMESTAMP'"}}}' > "$SESSIONS_FILE"
    }
}

case "$ACTION" in
    attention)
        update_session "attention" "\${2:-permission_prompt}"
        ;;
    start)
        update_session "running" ""
        ;;
    end)
        update_session "ended" ""
        ;;
    idle)
        update_session "idle" ""
        ;;
    *)
        echo "Unknown action: $ACTION" >&2
        exit 1
        ;;
esac
`;
}

function getHooksConfig(notifyScriptPath: string): Record<string, unknown> {
    return {
        Notification: [
            {
                matcher: 'permission_prompt|idle_prompt|elicitation_dialog',
                hooks: [
                    {
                        type: 'command',
                        command: `${notifyScriptPath} attention`
                    }
                ]
            }
        ],
        SessionStart: [
            {
                hooks: [
                    {
                        type: 'command',
                        command: `${notifyScriptPath} start`
                    }
                ]
            }
        ],
        SessionEnd: [
            {
                hooks: [
                    {
                        type: 'command',
                        command: `${notifyScriptPath} end`
                    }
                ]
            }
        ],
        Stop: [
            {
                hooks: [
                    {
                        type: 'command',
                        command: `${notifyScriptPath} idle`
                    }
                ]
            }
        ]
    };
}

function mergeHooks(
    existing: Record<string, unknown>,
    newHooks: Record<string, unknown>
): Record<string, unknown> {
    const merged = { ...existing };

    for (const [key, value] of Object.entries(newHooks)) {
        if (Array.isArray(merged[key])) {
            const existingHooks = merged[key] as unknown[];
            const newHookArray = value as unknown[];
            const filtered = existingHooks.filter(
                (h: unknown) => !JSON.stringify(h).includes('attention-monitor')
            );
            merged[key] = [...filtered, ...newHookArray];
        } else {
            merged[key] = value;
        }
    }

    return merged;
}

export function deactivate() {
    outputChannel?.appendLine('Claude Code Attention Monitor deactivated');
}
