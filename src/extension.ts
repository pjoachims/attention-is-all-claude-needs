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

// Debug logging - set to true for verbose console output
const DEBUG = false;

let outputChannel: vscode.OutputChannel;
let globalSessionManager: SessionManager;

// Cached workspace folders - updated on workspace change
let cachedWorkspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
let cachedWorkspacePaths: string[] = [];

// Focus request file for cross-window communication
const FOCUS_REQUEST_FILE = path.join(os.homedir(), '.claude', 'claude-attn', 'focus-request.json');

interface FocusRequest {
    sessionId: string;
    folder: string;
    vscodeIpcHandle?: string;  // Target window's IPC handle
    timestamp: number;
}

// Status bar items (order: claude, attention, idle, running from left to right)
let sbClaude: vscode.StatusBarItem;
let sbAttention: vscode.StatusBarItem;
let sbIdle: vscode.StatusBarItem;
let sbRunning: vscode.StatusBarItem;

// Track recently opened terminals for auto-association
let recentTerminal: { terminal: vscode.Terminal; timestamp: number } | null = null;

// Cache for terminal PIDs - cleared when terminals open/close
let terminalPidCache: Map<number, vscode.Terminal> | null = null;

// Cache for Windows process chain results - keyed by Claude PID
// Chain doesn't change for lifetime of a process, so cache for 10 minutes
const processChainCache = new Map<number, { chain: number[]; timestamp: number }>();
const PROCESS_CHAIN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Claude ATTN');
    outputChannel.appendLine('Claude Code Attention Monitor activated');

    // Initialize workspace folder cache
    updateWorkspaceFolderCache();

    // Update cache when workspace folders change
    const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        updateWorkspaceFolderCache();
    });

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

    // Update status bar when sessions change (store disposable to prevent memory leak)
    const sessionChangeListener = sessionManager.onDidChange(() => {
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
    context.subscriptions.push(sessionChangeListener);

    // Track when terminals open
    const terminalOpenListener = vscode.window.onDidOpenTerminal((terminal) => {
        outputChannel.appendLine(`Terminal opened: ${terminal.name}`);
        recentTerminal = { terminal, timestamp: Date.now() };
        // Invalidate terminal PID cache
        terminalPidCache = null;
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
        // Invalidate terminal PID cache
        terminalPidCache = null;
    });

    context.subscriptions.push(terminalOpenListener, terminalCloseListener);

    const treeView = vscode.window.createTreeView('claudeSessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    const dirWatcherListener = directoryWatcher.onDidChange(async () => {
        outputChannel.appendLine('Sessions directory changed, reloading...');
        await sessionManager.loadSessions();
    });
    context.subscriptions.push(dirWatcherListener);

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
        treeProvider,
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
        renameSessionCommand,
        workspaceFoldersListener
    );

    checkHooksSetup(context);
}

/**
 * Update the cached workspace folder paths.
 */
function updateWorkspaceFolderCache(): void {
    cachedWorkspaceFolders = vscode.workspace.workspaceFolders;
    cachedWorkspacePaths = cachedWorkspaceFolders?.map(f => f.uri.fsPath) ?? [];
    if (DEBUG) {
        console.log(`[updateWorkspaceFolderCache] Cached ${cachedWorkspacePaths.length} workspace paths`);
    }
}

/**
 * Get sessions filtered by workspace if globalMode is disabled.
 * In workspace mode, only returns sessions whose cwd is within any workspace folder.
 */
function getFilteredSessions(sessionManager: SessionManager): Session[] {
    const allSessions = sessionManager.getAllSessions();
    const globalMode = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('globalMode', false);

    if (DEBUG) {
        console.log(`[getFilteredSessions] Total sessions: ${allSessions.length}, globalMode: ${globalMode}`);
    }

    if (globalMode) {
        return allSessions;
    }

    // Use cached workspace paths
    if (cachedWorkspacePaths.length === 0) {
        if (DEBUG) {
            console.log('[getFilteredSessions] No workspace folders, returning all');
        }
        return allSessions; // No workspace, show all
    }

    return allSessions.filter(session => {
        if (!session.cwd) {
            return false;
        }
        // Unescape backslashes from JSON-escaped cwd for comparison
        const normalizedCwd = session.cwd.replace(/\\\\/g, '\\');
        return cachedWorkspacePaths.some(wp => normalizedCwd.toLowerCase().startsWith(wp.toLowerCase()));
    });
}

function updateStatusBar(sessionManager: SessionManager): void {
    const sessions = getFilteredSessions(sessionManager);

    // Count each status in a single pass
    let attention = 0;
    let idle = 0;
    let running = 0;
    for (const session of sessions) {
        switch (session.status) {
            case 'attention': attention++; break;
            case 'idle': idle++; break;
            case 'running': running++; break;
        }
    }

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
        outputChannel.appendLine(`focusTerminalForSession: session=${session.id}, cwd=${session.cwd}, inCurrentWorkspace=${isInCurrentWorkspace}`);
        if (!isInCurrentWorkspace) {
            // Try to switch to the correct VS Code window
            const switched = await switchToVSCodeWindow(session);
            if (switched) {
                outputChannel.appendLine(`Switched to VS Code window for ${session.cwd}`);
                // The other window will handle terminal focus via focus request
                return;
            } else {
                outputChannel.appendLine(`Could not switch to VS Code window for ${session.cwd} - falling back to current window`);
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

    // Only one terminal - use it directly (skip PID matching)
    if (terminals.length === 1) {
        terminalTracker.associate(session.id, terminals[0]);
        outputChannel.appendLine(`Auto-associated session ${session.id} with only terminal ${terminals[0].name}`);
        terminals[0].show();
        await clearAttentionIfNeeded(session);
        return;
    }

    // Multiple terminals - use terminalPid for fast matching
    const matched = await matchSessionToTerminal(session, terminals);
    if (matched) {
        terminalTracker.associate(session.id, matched);
        outputChannel.appendLine(`Matched session ${session.id} → terminal "${matched.name}"`);
        matched.show();
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
 * Get or refresh the terminal PID cache.
 */
async function getTerminalPidMap(terminals: readonly vscode.Terminal[]): Promise<Map<number, vscode.Terminal>> {
    if (terminalPidCache !== null) {
        return terminalPidCache;
    }

    const pidMap = new Map<number, vscode.Terminal>();
    for (const terminal of terminals) {
        try {
            const pid = await terminal.processId;
            if (pid !== undefined) {
                pidMap.set(pid, terminal);
            }
        } catch {
            // Terminal might have closed
        }
    }

    terminalPidCache = pidMap;
    return pidMap;
}

/**
 * Match a session to a terminal using terminalPid from session JSON.
 * Falls back to process tree walking for old sessions without terminalPid.
 */
async function matchSessionToTerminal(
    session: Session,
    terminals: readonly vscode.Terminal[]
): Promise<vscode.Terminal | undefined> {
    // Build terminal PID map
    const terminalPids = await getTerminalPidMap(terminals);

    // Fast path: use terminalPid directly if available
    if (session.terminalPid) {
        const terminal = terminalPids.get(session.terminalPid);
        if (terminal) {
            outputChannel.appendLine(`Direct terminalPid match: ${session.terminalPid}`);
            return terminal;
        }
    }

    // Fallback for old sessions: walk the process tree
    const claudePid = extractPidFromSessionId(session.id);
    if (claudePid === null) {
        return undefined;
    }

    outputChannel.appendLine(`Falling back to process tree walk for session ${session.id}`);
    const ancestorChain = await getProcessChain(claudePid);

    for (const pid of ancestorChain) {
        const terminal = terminalPids.get(pid);
        if (terminal) {
            return terminal;
        }
    }

    return undefined;
}

/**
 * Get the ancestor chain for a PID, with caching.
 * Process chains don't change, so we cache for 10 minutes.
 */
async function getProcessChain(startPid: number): Promise<number[]> {
    // Check cache first
    const cached = processChainCache.get(startPid);
    if (cached && Date.now() - cached.timestamp < PROCESS_CHAIN_CACHE_TTL) {
        if (DEBUG) {
            console.log(`[getProcessChain] Cache hit for PID ${startPid}`);
        }
        return cached.chain;
    }

    // Compute chain based on platform
    const chain = process.platform === 'win32'
        ? await getWindowsProcessChain(startPid)
        : await getUnixProcessChain(startPid);

    // Cache the result
    processChainCache.set(startPid, { chain, timestamp: Date.now() });

    if (DEBUG) {
        console.log(`[getProcessChain] Cached chain for PID ${startPid}: ${chain.join(' -> ')}`);
    }

    return chain;
}

/**
 * Get ancestor chain on Unix/macOS using ps command.
 */
async function getUnixProcessChain(startPid: number): Promise<number[]> {
    const chain: number[] = [];
    let currentPid: number | null = startPid;
    const maxDepth = 10;

    for (let i = 0; i < maxDepth && currentPid !== null && currentPid > 1; i++) {
        chain.push(currentPid);
        currentPid = await getParentPid(currentPid);
    }

    return chain;
}

/**
 * Get the ancestor chain for a specific PID on Windows.
 * Uses bulk query (~600ms) then walks in memory, discards bulk data after.
 * Returns array of PIDs from the given PID up to the root.
 */
async function getWindowsProcessChain(startPid: number): Promise<number[]> {
    return new Promise((resolve) => {
        // Bulk query all processes, walk chain in PowerShell, return only the chain
        // This is faster than per-PID queries (~600ms vs ~1800ms)
        // The bulk data is discarded after - only the small chain array is returned
        // Note: Must cast to [int] because ProcessId is UInt32 but hashtable lookup uses Int32
        const cmd = `powershell -NoProfile -Command "$procs=@{}; Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId]=[int]$_.ParentProcessId }; $id=${startPid}; $chain=@(); while($id -and $id -gt 0 -and $procs.ContainsKey($id)) { $chain+=$id; $id=$procs[$id] }; $chain -join ','"`;

        exec(cmd, { timeout: 10000 }, (error, stdout) => {
            if (error) {
                if (DEBUG) {
                    console.log('[getWindowsProcessChain] PowerShell failed:', error.message);
                }
                resolve([startPid]); // Return at least the starting PID
                return;
            }

            // Parse comma-separated PIDs
            const chain = stdout.trim().split(',')
                .map(s => parseInt(s.trim(), 10))
                .filter(n => !isNaN(n) && n > 0);

            if (DEBUG) {
                console.log(`[getWindowsProcessChain] Chain for ${startPid}: ${chain.join(' -> ')}`);
            }
            resolve(chain.length > 0 ? chain : [startPid]);
        });
    });
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

    // Normalize paths for comparison (Windows uses backslashes, git uses forward slashes)
    const normalizedFolder = folderPath.replace(/\//g, '\\').toLowerCase();

    for (const f of workspaceFolders) {
        const normalizedWorkspace = f.uri.fsPath.toLowerCase();
        if (normalizedFolder.startsWith(normalizedWorkspace) || normalizedWorkspace.startsWith(normalizedFolder)) {
            return true;
        }
    }
    return false;
}

/**
 * Handle incoming focus request from another VS Code window.
 * Uses IPC handle to identify if this window should handle the request.
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

        // Check if this request is for us by matching IPC handle
        const myIpcHandle = process.env.VSCODE_GIT_IPC_HANDLE;
        if (request.vscodeIpcHandle && myIpcHandle) {
            if (request.vscodeIpcHandle !== myIpcHandle) {
                outputChannel.appendLine(`Focus request not for this window (IPC mismatch)`);
                return;
            }
        } else {
            // Fallback to folder matching if no IPC handle
            if (!isFolderInCurrentWorkspace(request.folder)) {
                outputChannel.appendLine(`Focus request not for this workspace: ${request.folder}`);
                return;
            }
        }

        outputChannel.appendLine(`Handling focus request for session ${request.sessionId}`);

        // Clear the request file first (we're handling it)
        try {
            fs.unlinkSync(FOCUS_REQUEST_FILE);
        } catch {
            // Ignore - another window might have already handled it
        }

        // Find the session
        const session = sessionManager.getAllSessions().find(s => s.id === request.sessionId);
        if (!session) {
            outputChannel.appendLine(`Session not found: ${request.sessionId}`);
            return;
        }

        // Activate our window (bring to foreground)
        if (process.platform === 'win32') {
            const folderName = path.basename(request.folder);
            await activateWindowByFolder(folderName);
        }

        // Focus the terminal for this session
        const terminals = vscode.window.terminals;
        if (terminals.length === 0) {
            return;
        }

        // Try terminal matching
        const matched = await matchSessionToTerminal(session, terminals);
        if (matched) {
            terminalTracker.associate(session.id, matched);
            outputChannel.appendLine(`Focus request: matched terminal "${matched.name}"`);
            matched.show(false); // false = take focus
            await vscode.commands.executeCommand('workbench.action.terminal.focus');
            await clearAttentionIfNeeded(session);
        } else if (terminals.length === 1) {
            terminals[0].show(false);
            await vscode.commands.executeCommand('workbench.action.terminal.focus');
            await clearAttentionIfNeeded(session);
        }
    } catch (error) {
        outputChannel.appendLine(`Error handling focus request: ${error}`);
    }
}

/**
 * Write a focus request for another window to pick up.
 */
function writeFocusRequest(sessionId: string, folder: string, vscodeIpcHandle?: string): void {
    const request: FocusRequest = {
        sessionId,
        folder,
        vscodeIpcHandle,
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
 * Activate a VS Code window by folder name in title (Windows only).
 * Uses PowerShell script with Win32 API to enumerate windows and find match.
 */
async function activateWindowByFolder(folderName: string): Promise<boolean> {
    if (process.platform !== 'win32') {
        return false;
    }

    const scriptPath = path.join(os.homedir(), '.claude', 'claude-attn', 'activate-vscode-window.ps1');

    return new Promise((resolve) => {
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -FolderName "${folderName}"`;

        exec(cmd, { timeout: 3000 }, (error: Error | null, stdout: string) => {
            if (error) {
                outputChannel.appendLine(`activateWindowByFolder error: ${error.message}`);
                resolve(false);
                return;
            }
            const success = stdout.toLowerCase().includes('true');
            outputChannel.appendLine(`activateWindowByFolder(${folderName}): ${success}`);
            resolve(success);
        });
    });
}

/**
 * Switch to the VS Code window for the given session.
 * Uses vscodePid if available (fast), falls back to code command.
 */
async function switchToVSCodeWindow(session: Session): Promise<boolean> {
    const folderPath = session.cwd!;
    const gitRoot = await getGitRoot(folderPath);
    const targetPath = gitRoot || folderPath;
    const folderName = path.basename(targetPath);

    outputChannel.appendLine(`switchToVSCodeWindow: session=${session.id}, folder=${folderName}, ipc=${session.vscodeIpcHandle}`);

    // Write focus request with IPC handle - target window will identify itself and handle activation
    writeFocusRequest(session.id, targetPath, session.vscodeIpcHandle);

    // The target window will activate itself when it receives the focus request.
    // But we also try to activate it from here for faster response.
    if (process.platform === 'win32') {
        const activated = await activateWindowByFolder(folderName);
        if (activated) {
            outputChannel.appendLine(`Window activated via folder name "${folderName}"`);
            return true;
        }
        outputChannel.appendLine(`Folder activation failed, falling back to code command`);
    }

    // Fallback: Find a file to open (this triggers window focus)
    const fileToOpen = await findFileToOpen(targetPath);
    if (!fileToOpen) {
        outputChannel.appendLine(`No file found to open in ${targetPath}`);
        return false;
    }

    return new Promise((resolve) => {
        const cmd = process.platform === 'win32'
            ? `cmd.exe /c start /min code "${fileToOpen}"`
            : `code "${fileToOpen}"`;

        exec(cmd, { timeout: 5000 }, (error: Error | null) => {
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
    // Always deploy/update scripts on activation (handles extension updates)
    await deployScripts();

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

/**
 * Deploy notification scripts to ~/.claude/claude-attn/.
 * Called on every activation to ensure scripts are up-to-date after extension updates.
 */
async function deployScripts(): Promise<void> {
    const claudeDir = path.join(os.homedir(), '.claude');
    const monitorDir = path.join(claudeDir, 'claude-attn');
    const sessionsDir = path.join(monitorDir, 'sessions');

    const isWindows = process.platform === 'win32';
    const scriptExt = isWindows ? '.cmd' : '.sh';
    const notifyScriptPath = path.join(monitorDir, `notify${scriptExt}`);

    try {
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }

        // Clean up old/wrong-platform scripts
        const oldScriptExt = isWindows ? '.sh' : '.cmd';
        const oldNotifyScript = path.join(monitorDir, `notify${oldScriptExt}`);
        if (fs.existsSync(oldNotifyScript)) {
            fs.unlinkSync(oldNotifyScript);
            outputChannel.appendLine(`Removed old script: ${oldNotifyScript}`);
        }

        // On non-Windows, remove PowerShell scripts that aren't needed
        if (!isWindows) {
            const psScripts = ['get-claude-pid.ps1', 'activate-vscode-window.ps1'];
            for (const script of psScripts) {
                const scriptPath = path.join(monitorDir, script);
                if (fs.existsSync(scriptPath)) {
                    fs.unlinkSync(scriptPath);
                    outputChannel.appendLine(`Removed unneeded script: ${scriptPath}`);
                }
            }
        }

        const notifyScript = isWindows ? getNotifyScriptWindows() : getNotifyScriptUnix();
        fs.writeFileSync(notifyScriptPath, notifyScript, { mode: isWindows ? 0o644 : 0o755 });

        // On Windows, also deploy the PowerShell helper scripts
        if (isWindows) {
            const psScriptPath = path.join(monitorDir, 'get-claude-pid.ps1');
            fs.writeFileSync(psScriptPath, getClaudePidScript());

            const activateScriptPath = path.join(monitorDir, 'activate-vscode-window.ps1');
            fs.writeFileSync(activateScriptPath, getActivateWindowScript());
        }

        outputChannel.appendLine(`Scripts deployed to ${monitorDir}`);
    } catch (error) {
        outputChannel.appendLine(`Error deploying scripts: ${error}`);
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

        // On Windows, also deploy the PowerShell helper scripts
        if (isWindows) {
            const psScriptPath = path.join(monitorDir, 'get-claude-pid.ps1');
            fs.writeFileSync(psScriptPath, getClaudePidScript());

            const activateScriptPath = path.join(monitorDir, 'activate-vscode-window.ps1');
            fs.writeFileSync(activateScriptPath, getActivateWindowScript());
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
SESSIONS_DIR=~/.claude/claude-attn/sessions
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Get PIDs: Claude (PPID of this script), Terminal (Claude's parent)
CLAUDE_PID=$PPID
TERMINAL_PID=$(ps -o ppid= -p $CLAUDE_PID 2>/dev/null | tr -d ' ')
SESSION_ID="\${CLAUDE_SESSION_ID:-ppid-$CLAUDE_PID}"

# VS Code IPC handle - unique per VS Code window
IPC_HANDLE="\${VSCODE_GIT_IPC_HANDLE:-}"

# Build extra fields for JSON
EXTRA_FIELDS=""
[[ -n "$CLAUDE_PID" ]] && EXTRA_FIELDS=",\\"claudePid\\":$CLAUDE_PID"
[[ -n "$TERMINAL_PID" ]] && EXTRA_FIELDS="$EXTRA_FIELDS,\\"terminalPid\\":$TERMINAL_PID"
[[ -n "$IPC_HANDLE" ]] && EXTRA_FIELDS="$EXTRA_FIELDS,\\"vscodeIpcHandle\\":\\"$IPC_HANDLE\\""

mkdir -p "$SESSIONS_DIR"
SESSION_FILE="$SESSIONS_DIR/$SESSION_ID.json"

case "$ACTION" in
    attention)
        printf '{"id":"%s","status":"attention","reason":"%s","cwd":"%s","lastUpdate":"%s"%s}' \\
            "$SESSION_ID" "$REASON" "$CWD" "$TIMESTAMP" "$EXTRA_FIELDS" > "$SESSION_FILE"
        ;;
    start)
        printf '{"id":"%s","status":"running","cwd":"%s","lastUpdate":"%s"%s}' \\
            "$SESSION_ID" "$CWD" "$TIMESTAMP" "$EXTRA_FIELDS" > "$SESSION_FILE"
        ;;
    end)
        rm -f "$SESSION_FILE"
        ;;
    idle)
        printf '{"id":"%s","status":"idle","cwd":"%s","lastUpdate":"%s"%s}' \\
            "$SESSION_ID" "$CWD" "$TIMESTAMP" "$EXTRA_FIELDS" > "$SESSION_FILE"
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

set "SESSION_ID="
set "CLAUDE_PID="
set "TERMINAL_PID="

:: Get Claude PID and Terminal PID via PowerShell helper script
for /f "usebackq tokens=1,2 delims=," %%A in (\`powershell -NoProfile -ExecutionPolicy Bypass -File "!PS_SCRIPT!"\`) do (
    set "CLAUDE_PID=%%A"
    set "TERMINAL_PID=%%B"
)

if defined CLAUDE_SESSION_ID (
    set "SESSION_ID=%CLAUDE_SESSION_ID%"
) else if defined CLAUDE_PID (
    set "SESSION_ID=ppid-!CLAUDE_PID!"
) else (
    set "SESSION_ID=win-%RANDOM%%RANDOM%"
)

if defined CLAUDE_WORKING_DIRECTORY (
    set "CWD=%CLAUDE_WORKING_DIRECTORY%"
) else (
    set "CWD=%CD%"
)
:: Escape backslashes for JSON
set "CWD=!CWD:\\=\\\\!"

:: VS Code IPC handle - unique per VS Code window
set "IPC_HANDLE=%VSCODE_GIT_IPC_HANDLE%"
:: Escape backslashes in IPC handle for JSON
set "IPC_HANDLE=!IPC_HANDLE:\\=\\\\!"

set "SESSIONS_DIR=%USERPROFILE%\\.claude\\claude-attn\\sessions"
if not exist "%SESSIONS_DIR%" mkdir "%SESSIONS_DIR%"
set "SESSION_FILE=%SESSIONS_DIR%\\!SESSION_ID!.json"

:: Get timestamp via PowerShell (more reliable than WMIC)
for /f "usebackq delims=" %%T in (\`powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'"\`) do set "TIMESTAMP=%%T"
if not defined TIMESTAMP set "TIMESTAMP=unknown"

:: Build extra fields for JSON
set "EXTRA_FIELDS="
if defined CLAUDE_PID if not "!CLAUDE_PID!"=="" set EXTRA_FIELDS=,"claudePid":!CLAUDE_PID!
if defined TERMINAL_PID if not "!TERMINAL_PID!"=="" set EXTRA_FIELDS=!EXTRA_FIELDS!,"terminalPid":!TERMINAL_PID!
if defined IPC_HANDLE if not "!IPC_HANDLE!"=="" set EXTRA_FIELDS=!EXTRA_FIELDS!,"vscodeIpcHandle":"!IPC_HANDLE!"

if "%ACTION%"=="attention" (
    echo {"id":"!SESSION_ID!","status":"attention","reason":"%REASON%","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"!EXTRA_FIELDS!}>"%SESSION_FILE%"
) else if "%ACTION%"=="start" (
    echo {"id":"!SESSION_ID!","status":"running","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"!EXTRA_FIELDS!}>"%SESSION_FILE%"
) else if "%ACTION%"=="end" (
    if exist "%SESSION_FILE%" del "%SESSION_FILE%"
) else if "%ACTION%"=="idle" (
    echo {"id":"!SESSION_ID!","status":"idle","cwd":"!CWD!","lastUpdate":"!TIMESTAMP!"!EXTRA_FIELDS!}>"%SESSION_FILE%"
)
`;
}

function getClaudePidScript(): string {
    return `# Walk up process tree to find Claude PID and Terminal PID
# Output format: claudePid,terminalPid
$currentPid = $PID
$maxLevels = 15
$claudePid = ""
$terminalPid = ""

for ($i = 0; $i -lt $maxLevels; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
    if (-not $proc) { break }

    $parentPid = $proc.ParentProcessId
    $parentProc = Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid" -ErrorAction SilentlyContinue
    if (-not $parentProc) { break }

    # Check if parent is node.exe or claude.exe (Claude Code)
    if (-not $claudePid -and ($parentProc.Name -eq "node.exe" -or $parentProc.Name -eq "claude.exe")) {
        $claudePid = $parentPid
    }
    # Once we found Claude, the next shell-like process is the terminal
    elseif ($claudePid -and -not $terminalPid) {
        # Terminal is typically cmd.exe, powershell.exe, pwsh.exe, or bash.exe
        if ($parentProc.Name -match "^(cmd|powershell|pwsh|bash|zsh|fish|sh)\\.exe$") {
            $terminalPid = $parentPid
            break  # Found both, we're done
        }
    }

    # Check if parent is Code.exe - use current as terminal if we haven't found one
    if ($parentProc.Name -eq "Code.exe") {
        if (-not $terminalPid -and $claudePid) {
            $terminalPid = $currentPid
        }
        break
    }

    $currentPid = $parentPid
}

# Output both PIDs (comma-separated)
Write-Host "$claudePid,$terminalPid"
`;
}

function getActivateWindowScript(): string {
    return `# Activate VS Code window by folder name in title
# Usage: activate-vscode-window.ps1 -FolderName "my-project"
param(
    [Parameter(Mandatory=$true)]
    [string]$FolderName
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WindowActivator {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public const int SW_RESTORE = 9;
    public const int SW_SHOWNOACTIVATE = 4;

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);  // Returns true if minimized

    private static IntPtr foundHwnd = IntPtr.Zero;
    private static string searchTerm = "";

    public static IntPtr FindWindowByTitleContains(string term) {
        foundHwnd = IntPtr.Zero;
        searchTerm = term.ToLower();

        EnumWindows((hWnd, lParam) => {
            if (IsWindowVisible(hWnd)) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                string title = sb.ToString().ToLower();

                if (title.Contains("visual studio code") && title.Contains(searchTerm)) {
                    foundHwnd = hWnd;
                    return false;
                }
            }
            return true;
        }, IntPtr.Zero);

        return foundHwnd;
    }

    public static bool ActivateWindow(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return false;

        IntPtr foregroundHwnd = GetForegroundWindow();
        uint dummy;
        uint foregroundThread = GetWindowThreadProcessId(foregroundHwnd, out dummy);
        uint currentThread = GetCurrentThreadId();

        bool attached = false;
        if (foregroundThread != currentThread) {
            attached = AttachThreadInput(currentThread, foregroundThread, true);
        }

        try {
            // Only restore if minimized - don't change maximized/normal state
            if (IsIconic(hWnd)) {
                ShowWindow(hWnd, SW_RESTORE);
            }
            return SetForegroundWindow(hWnd);
        }
        finally {
            if (attached) {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
    }
}
"@

$hwnd = [WindowActivator]::FindWindowByTitleContains($FolderName)

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output "NotFound"
    exit 1
}

$result = [WindowActivator]::ActivateWindow($hwnd)
Write-Output $result
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
