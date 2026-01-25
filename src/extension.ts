import * as vscode from 'vscode';
import * as path from 'path';
import { SessionManager, Session } from './sessionManager';
import { createDirectoryWatcher, createFileWatcher } from './fsWatcher';
import { SessionTreeProvider } from './views/sessionTreeView';
import { SessionCleaner } from './sessionCleaner';
import { aliasManager } from './aliasManager';
import { terminalTracker } from './terminalTracker';
import { StatusBarManager } from './statusBar';
import { HookManager } from './hookManager';
import { CrossWindowIpc } from './crossWindowIpc';

// Debug logging - set to true for verbose console output
const DEBUG = false;

let outputChannel: vscode.OutputChannel;
let globalSessionManager: SessionManager;

// Cached workspace folders - updated on workspace change
let cachedWorkspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
let cachedWorkspacePaths: string[] = [];

// Status bar manager
let statusBarManager: StatusBarManager;

// Hook manager
let hookManager: HookManager;

// Cross-window IPC manager
let crossWindowIpc: CrossWindowIpc;

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
    const directoryWatcher = createDirectoryWatcher(sessionManager.getSessionsDirPath());
    const treeProvider = new SessionTreeProvider(sessionManager);

    // Create status bar manager
    statusBarManager = new StatusBarManager();
    updateStatusBar(sessionManager);

    // Create hook manager
    hookManager = new HookManager(context.extensionPath, outputChannel);

    // Create cross-window IPC manager
    crossWindowIpc = new CrossWindowIpc(outputChannel, matchSessionToTerminal, clearAttentionIfNeeded);

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
    });

    // Clean up when terminals close
    const terminalCloseListener = vscode.window.onDidCloseTerminal((terminal) => {
        const sessionId = terminalTracker.getSessionForTerminal(terminal);
        if (sessionId) {
            outputChannel.appendLine(`Terminal closed, removed association for session ${sessionId}`);
        }
        terminalTracker.removeTerminal(terminal);
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
    const focusRequestWatcher = createFileWatcher(crossWindowIpc.getFocusRequestFilePath());
    focusRequestWatcher.onDidChange(async () => {
        await crossWindowIpc.handleIncomingFocusRequest(sessionManager);
    });
    focusRequestWatcher.start();
    context.subscriptions.push(focusRequestWatcher);

    // Load session aliases and watch for changes from other windows
    aliasManager.load().then(() => {
        outputChannel.appendLine(`Loaded ${aliasManager.getCount()} session aliases`);
    });
    const aliasFileWatcher = createFileWatcher(aliasManager.getFilePath());
    aliasFileWatcher.onDidChange(async () => {
        await aliasManager.load();
        treeProvider.refresh();
        outputChannel.appendLine(`Reloaded aliases from file (changed by another window)`);
    });
    aliasFileWatcher.start();
    context.subscriptions.push(aliasFileWatcher);

    // Initialize session cleaner
    const sessionCleaner = new SessionCleaner(sessionManager);
    sessionCleaner.cleanupNow().then(result => {
        if (result.removedCount > 0) {
            outputChannel.appendLine(`Cleaned up ${result.removedCount} dead session(s): ${result.removedIds.join(', ')}`);
        }
    });
    sessionCleaner.start();

    // Register all commands
    const commands = registerCommands(context, sessionManager, treeProvider, sessionCleaner);

    context.subscriptions.push(
        outputChannel,
        statusBarManager,
        sessionManager,
        directoryWatcher,
        treeView,
        treeProvider,
        sessionCleaner,
        workspaceFoldersListener,
        ...commands
    );

    hookManager.checkAndPromptSetup(context);
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
    const globalMode = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('globalMode', false);
    statusBarManager.update(sessions, globalMode);
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

async function focusTerminalForSession(session: Session): Promise<void> {
    const globalMode = vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('globalMode', false);

    // In global mode, check if we need to switch VS Code windows
    if (globalMode && session.cwd) {
        const isInCurrentWorkspace = crossWindowIpc.isSessionInCurrentWorkspace(session);
        outputChannel.appendLine(`focusTerminalForSession: session=${session.id}, cwd=${session.cwd}, inCurrentWorkspace=${isInCurrentWorkspace}`);
        if (!isInCurrentWorkspace) {
            // Try to switch to the correct VS Code window
            const switched = await crossWindowIpc.switchToWindow(session);
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
 * Match a session to a terminal using terminalPid from session JSON.
 */
async function matchSessionToTerminal(
    session: Session,
    terminals: readonly vscode.Terminal[]
): Promise<vscode.Terminal | undefined> {
    if (!session.terminalPid) {
        return undefined;
    }

    for (const terminal of terminals) {
        try {
            const pid = await terminal.processId;
            if (pid === session.terminalPid) {
                outputChannel.appendLine(`Direct terminalPid match: ${session.terminalPid}`);
                return terminal;
            }
        } catch {
            // Terminal might have closed
        }
    }

    return undefined;
}


/**
 * Get the display name for a session (alias or derived name)
 */
function getSessionLabel(session: Session): string {
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
 * Register all extension commands.
 */
function registerCommands(
    context: vscode.ExtensionContext,
    sessionManager: SessionManager,
    treeProvider: SessionTreeProvider,
    sessionCleaner: SessionCleaner
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('claude-monitor.refresh', async () => {
            outputChannel.appendLine('Manual refresh triggered');
            await sessionManager.loadSessions();
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('claude-monitor.focusSession', async (session: Session) => {
            outputChannel.appendLine(`Focusing session: ${session.id}`);
            await focusTerminalForSession(session);
        }),

        vscode.commands.registerCommand('claude-monitor.manageAssociations', async () => {
            await handleManageAssociations(sessionManager);
        }),

        vscode.commands.registerCommand('claude-monitor.clickAttention', async () => {
            await handleCategoryClick(sessionManager, 'attention');
        }),

        vscode.commands.registerCommand('claude-monitor.clickRunning', async () => {
            await handleCategoryClick(sessionManager, 'running');
        }),

        vscode.commands.registerCommand('claude-monitor.clickIdle', async () => {
            await handleCategoryClick(sessionManager, 'idle');
        }),

        vscode.commands.registerCommand('claude-monitor.setupHooks', async () => {
            await hookManager.setupHooks(context);
        }),

        vscode.commands.registerCommand('claude-monitor.removeHooks', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'This will remove Claude ATTN hooks from Claude Code settings and delete all session data. Continue?',
                { modal: true },
                'Remove Hooks'
            );

            if (confirm !== 'Remove Hooks') {
                return;
            }

            try {
                await hookManager.removeHooks();
                vscode.window.showInformationMessage(
                    'Claude ATTN hooks removed. You can now safely uninstall the extension.'
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to remove hooks: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }),

        vscode.commands.registerCommand('claude-monitor.cleanupStaleSessions', async () => {
            outputChannel.appendLine('Manual cleanup triggered');
            const result = await sessionCleaner.cleanupNow();
            if (result.removedCount > 0) {
                vscode.window.showInformationMessage(`Cleaned up ${result.removedCount} stale session(s)`);
                outputChannel.appendLine(`Removed sessions: ${result.removedIds.join(', ')}`);
            } else {
                vscode.window.showInformationMessage('No stale sessions found');
            }
        }),

        vscode.commands.registerCommand('claude-monitor.cleanupAllSessions', async () => {
            const sessions = sessionManager.getAllSessions();
            if (sessions.length === 0) {
                vscode.window.showInformationMessage('No sessions to clean up.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Remove all ${sessions.length} session(s)? This will clear the session list.`,
                { modal: true },
                'Remove All'
            );

            if (confirm === 'Remove All') {
                const sessionIds = sessions.map(s => s.id);
                await sessionManager.removeSessions(sessionIds);
                treeProvider.refresh();
                vscode.window.showInformationMessage(`Removed ${sessionIds.length} session(s).`);
            }
        }),

        vscode.commands.registerCommand('claude-monitor.renameSession', async (item?: unknown) => {
            let session: Session | undefined;
            if (item && typeof item === 'object' && 'session' in item) {
                session = (item as { session?: Session }).session;
            } else if (item && typeof item === 'object' && 'id' in item && 'status' in item) {
                session = item as Session;
            }

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
        })
    ];
}

export function deactivate() {
    outputChannel?.appendLine('Claude Code Attention Monitor deactivated');
}
