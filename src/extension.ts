import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { SessionManager, Session } from './sessionManager';
import { DirectoryWatcher } from './directoryWatcher';
import { FileWatcher } from './fileWatcher';
import { SessionTreeProvider } from './views/sessionTreeView';
import { SessionCleaner } from './sessionCleaner';
import { aliasManager } from './aliasManager';
import { terminalTracker } from './terminalTracker';

let outputChannel: vscode.OutputChannel;
let globalSessionManager: SessionManager;

// Focus request file for cross-window communication
const FOCUS_REQUEST_FILE = path.join(os.homedir(), '.claude', 'claude-attn', 'focus-request.json');

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
    outputChannel = vscode.window.createOutputChannel('Claude ATTN');
    outputChannel.appendLine('Claude Code Attention Monitor activated');

    const sessionManager = new SessionManager();
    globalSessionManager = sessionManager;
    const directoryWatcher = new DirectoryWatcher(sessionManager.getSessionsDirPath());
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

    directoryWatcher.onDidChange(async () => {
        outputChannel.appendLine('Sessions directory changed, reloading...');
        await sessionManager.loadSessions();
    });

    directoryWatcher.start();
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

    const removeHooksCommand = vscode.commands.registerCommand(
        'claude-monitor.removeHooks',
        async () => {
            const confirm = await vscode.window.showWarningMessage(
                'This will remove Claude ATTN hooks from Claude Code settings and delete all session data. Continue?',
                { modal: true },
                'Remove Hooks'
            );

            if (confirm !== 'Remove Hooks') {
                return;
            }

            try {
                await removeClaudeHooks();
                vscode.window.showInformationMessage(
                    'Claude ATTN hooks removed. You can now safely uninstall the extension.'
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to remove hooks: ${error instanceof Error ? error.message : String(error)}`
                );
            }
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
        directoryWatcher,
        treeView,
        refreshCommand,
        focusSessionCommand,
        manageAssociationsCommand,
        clickAttentionCommand,
        clickRunningCommand,
        clickIdleCommand,
        setupHooksCommand,
        removeHooksCommand,
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

    console.log(`[getFilteredSessions] Total sessions: ${allSessions.length}, globalMode: ${globalMode}`);

    if (globalMode) {
        return allSessions;
    }

    // Filter to sessions within current workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        console.log('[getFilteredSessions] No workspace folders, returning all');
        return allSessions; // No workspace, show all
    }

    const workspacePaths = workspaceFolders.map(f => f.uri.fsPath);
    console.log(`[getFilteredSessions] Workspace paths: ${workspacePaths.join(', ')}`);

    const filtered = allSessions.filter(session => {
        if (!session.cwd) {
            console.log(`[getFilteredSessions] Session ${session.id} has no cwd`);
            return false;
        }
        // Unescape backslashes from JSON-escaped cwd for comparison
        const normalizedCwd = session.cwd.replace(/\\\\/g, '\\');
        const matches = workspacePaths.some(wp => normalizedCwd.toLowerCase().startsWith(wp.toLowerCase()));
        console.log(`[getFilteredSessions] Session ${session.id} cwd: "${session.cwd}" -> normalized: "${normalizedCwd}" -> matches: ${matches}`);
        return matches;
    });

    console.log(`[getFilteredSessions] Filtered to ${filtered.length} sessions`);
    return filtered;
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
    const monitorDir = path.join(claudeDir, 'claude-attn');
    const sessionsDir = path.join(monitorDir, 'sessions');
    const settingsPath = path.join(claudeDir, 'settings.json');

    const isWindows = process.platform === 'win32';
    const scriptExt = isWindows ? '.cmd' : '.sh';
    const notifyScriptPath = path.join(monitorDir, `notify${scriptExt}`);

    try {
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }

        const notifyScript = isWindows ? getNotifyScriptWindows() : getNotifyScriptUnix();
        fs.writeFileSync(notifyScriptPath, notifyScript, { mode: isWindows ? 0o644 : 0o755 });

        // On Windows, also deploy the PowerShell helper script
        if (isWindows) {
            const psScriptPath = path.join(monitorDir, 'get-claude-pid.ps1');
            fs.writeFileSync(psScriptPath, getClaudePidScript());
        }

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

async function removeClaudeHooks(): Promise<void> {
    const claudeDir = path.join(os.homedir(), '.claude');
    const monitorDir = path.join(claudeDir, 'claude-attn');
    const settingsPath = path.join(claudeDir, 'settings.json');

    // Remove hooks from Claude Code settings
    if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(content) as Record<string, unknown>;

        if (settings.hooks && typeof settings.hooks === 'object') {
            const hooks = settings.hooks as Record<string, unknown[]>;

            // Filter out any hooks containing 'claude-attn'
            for (const [key, value] of Object.entries(hooks)) {
                if (Array.isArray(value)) {
                    hooks[key] = value.filter(
                        (h: unknown) => !JSON.stringify(h).includes('claude-attn')
                    );
                    // Remove empty arrays
                    if (hooks[key].length === 0) {
                        delete hooks[key];
                    }
                }
            }

            // Remove hooks object if empty
            if (Object.keys(hooks).length === 0) {
                delete settings.hooks;
            }

            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        }
    }

    // Delete the attention-monitor directory
    if (fs.existsSync(monitorDir)) {
        fs.rmSync(monitorDir, { recursive: true, force: true });
    }

    outputChannel.appendLine('Hooks removed successfully');
    outputChannel.appendLine(`Deleted directory: ${monitorDir}`);
    outputChannel.appendLine(`Updated settings: ${settingsPath}`);
}

function getNotifyScriptUnix(): string {
    return `#!/bin/bash
# Claude Code Attention Monitor - Fast Hook Script
# Uses one file per session - no JSON parsing needed

[[ "$TERM_PROGRAM" != "vscode" ]] && exit 0

ACTION="$1"
REASON="\${2:-permission_prompt}"
CWD="\${CLAUDE_WORKING_DIRECTORY:-$(pwd)}"
SESSION_ID="\${CLAUDE_SESSION_ID:-ppid-$PPID}"
SESSIONS_DIR=~/.claude/claude-attn/sessions
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$SESSIONS_DIR"
SESSION_FILE="$SESSIONS_DIR/$SESSION_ID.json"

case "$ACTION" in
    attention)
        printf '{"id":"%s","status":"attention","reason":"%s","cwd":"%s","lastUpdate":"%s"}' \\
            "$SESSION_ID" "$REASON" "$CWD" "$TIMESTAMP" > "$SESSION_FILE"
        ;;
    start)
        printf '{"id":"%s","status":"running","cwd":"%s","lastUpdate":"%s"}' \\
            "$SESSION_ID" "$CWD" "$TIMESTAMP" > "$SESSION_FILE"
        ;;
    end)
        rm -f "$SESSION_FILE"
        ;;
    idle)
        printf '{"id":"%s","status":"idle","cwd":"%s","lastUpdate":"%s"}' \\
            "$SESSION_ID" "$CWD" "$TIMESTAMP" > "$SESSION_FILE"
        ;;
esac
`;
}

function getNotifyScriptWindows(): string {
    return `@echo off
setlocal enabledelayedexpansion

set "ACTION=%~1"
set "REASON=%~2"
if "%REASON%"=="" set "REASON=permission_prompt"

:: Set PS script path first (before any if blocks for proper variable expansion)
set "PS_SCRIPT=%USERPROFILE%\\.claude\\claude-attn\\get-claude-pid.ps1"

if defined CLAUDE_SESSION_ID (
    set "SESSION_ID=%CLAUDE_SESSION_ID%"
) else (
    set "SESSION_ID="
    :: Get Claude Code's PID via PowerShell helper script
    for /f "usebackq delims=" %%P in (\`powershell -NoProfile -ExecutionPolicy Bypass -File "!PS_SCRIPT!"\`) do (
        set "SESSION_ID=ppid-%%P"
    )
    :: Fallback to random if PowerShell fails
    if "!SESSION_ID!"=="" set "SESSION_ID=win-%RANDOM%%RANDOM%"
)

if defined CLAUDE_WORKING_DIRECTORY (
    set "CWD=%CLAUDE_WORKING_DIRECTORY%"
) else (
    set "CWD=%CD%"
)
:: Escape backslashes for JSON
set "CWD=!CWD:\\=\\\\!"

set "SESSIONS_DIR=%USERPROFILE%\\.claude\\claude-attn\\sessions"
if not exist "%SESSIONS_DIR%" mkdir "%SESSIONS_DIR%"
set "SESSION_FILE=%SESSIONS_DIR%\\!SESSION_ID!.json"

:: Get timestamp via PowerShell (more reliable than WMIC)
for /f "usebackq delims=" %%T in (\`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'"\`) do set "TIMESTAMP=%%T"
if not defined TIMESTAMP set "TIMESTAMP=unknown"

if "%ACTION%"=="attention" (
    echo {"id":"!SESSION_ID!","status":"attention","reason":"%REASON%","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"}>"%SESSION_FILE%"
) else if "%ACTION%"=="start" (
    echo {"id":"!SESSION_ID!","status":"running","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"}>"%SESSION_FILE%"
) else if "%ACTION%"=="end" (
    if exist "%SESSION_FILE%" del "%SESSION_FILE%"
) else if "%ACTION%"=="idle" (
    echo {"id":"!SESSION_ID!","status":"idle","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"}>"%SESSION_FILE%"
)
`;
}

function getClaudePidScript(): string {
    return `# Walk up the process tree to find Claude Code (node.exe or claude.exe)
$currentPid = $PID
$maxLevels = 10

for ($i = 0; $i -lt $maxLevels; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
    if (-not $proc) { break }

    $parentPid = $proc.ParentProcessId
    $parentProc = Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid" -ErrorAction SilentlyContinue
    if (-not $parentProc) { break }

    # Check if parent is node.exe or claude.exe (Claude Code)
    if ($parentProc.Name -eq "node.exe" -or $parentProc.Name -eq "claude.exe") {
        Write-Host $parentPid
        exit 0
    }

    $currentPid = $parentPid
}
`;
}

function getHooksConfig(notifyScriptPath: string): Record<string, unknown> {
    const isWindows = process.platform === 'win32';
    // On Windows, we need cmd.exe /c to run batch files
    const cmdPrefix = isWindows ? 'cmd.exe /c ' : '';

    return {
        Notification: [
            {
                matcher: 'permission_prompt|idle_prompt|elicitation_dialog',
                hooks: [
                    {
                        type: 'command',
                        command: `${cmdPrefix}"${notifyScriptPath}" attention`
                    }
                ]
            }
        ],
        SessionStart: [
            {
                hooks: [
                    {
                        type: 'command',
                        command: `${cmdPrefix}"${notifyScriptPath}" start`
                    }
                ]
            }
        ],
        SessionEnd: [
            {
                hooks: [
                    {
                        type: 'command',
                        command: `${cmdPrefix}"${notifyScriptPath}" end`
                    }
                ]
            }
        ],
        Stop: [
            {
                hooks: [
                    {
                        type: 'command',
                        command: `${cmdPrefix}"${notifyScriptPath}" idle`
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
                (h: unknown) => !JSON.stringify(h).includes('claude-attn')
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
