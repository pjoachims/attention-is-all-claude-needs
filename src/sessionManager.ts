import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { promises as fsPromises } from 'fs';

// Debug logging - set to true for verbose console output
const DEBUG = false;

export type SessionStatus = 'attention' | 'running' | 'idle';

export interface Session {
    id: string;
    status: SessionStatus;
    reason?: string;
    cwd?: string;
    lastUpdate: string;
    terminalPid?: number;    // Terminal shell PID (for fast terminal matching)
    vscodeIpcHandle?: string; // VS Code IPC handle (deprecated, kept for compatibility)
    windowId?: string;        // VS Code window ID (vscode.env.sessionId, for cross-window switching)
    windowHandle?: string;    // Windows HWND captured at session start (for reliable window switching)
}

export class SessionManager {
    private sessions: Map<string, Session> = new Map();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private readonly sessionsDirPath: string;

    constructor(sessionsDirPath?: string) {
        this.sessionsDirPath = sessionsDirPath ?? path.join(
            os.homedir(),
            '.claude',
            'claude-attn',
            'sessions'
        );
    }

    getSessionsDirPath(): string {
        return this.sessionsDirPath;
    }

    async loadSessions(): Promise<void> {
        try {
            this.sessions.clear();

            if (DEBUG) {
                console.log(`[SessionManager] Loading from: ${this.sessionsDirPath}`);
            }

            // Create directory if it doesn't exist
            try {
                await fsPromises.access(this.sessionsDirPath);
            } catch {
                await fsPromises.mkdir(this.sessionsDirPath, { recursive: true });
                this._onDidChange.fire();
                return;
            }

            const files = await fsPromises.readdir(this.sessionsDirPath);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            if (DEBUG) {
                console.log(`[SessionManager] Found ${jsonFiles.length} JSON files`);
            }

            // Read all files in parallel
            const readPromises = jsonFiles.map(async (file) => {
                try {
                    const filePath = path.join(this.sessionsDirPath, file);
                    const content = await fsPromises.readFile(filePath, 'utf-8');
                    const session: Session = JSON.parse(content);
                    if (session.id && session.status) {
                        return session;
                    }
                } catch (e) {
                    if (DEBUG) {
                        console.error(`[SessionManager] Failed to parse ${file}:`, e);
                    }
                }
                return null;
            });

            const results = await Promise.all(readPromises);
            for (const session of results) {
                if (session) {
                    this.sessions.set(session.id, session);
                }
            }

            if (DEBUG) {
                console.log(`[SessionManager] Total sessions loaded: ${this.sessions.size}`);
            }
            this._onDidChange.fire();
        } catch (error) {
            if (DEBUG) {
                console.error('[SessionManager] Failed to load sessions:', error);
            }
            this.sessions.clear();
            this._onDidChange.fire();
        }
    }

    async removeSession(sessionId: string): Promise<void> {
        await this.removeSessions([sessionId]);
    }

    async removeSessions(sessionIds: string[]): Promise<void> {
        // Delete files in parallel (async, non-blocking)
        await Promise.all(sessionIds.map(async (id) => {
            const filePath = path.join(this.sessionsDirPath, `${id}.json`);
            try {
                await fsPromises.unlink(filePath);
            } catch {
                // File may not exist, ignore
            }
        }));

        // Update in-memory map directly instead of full reload
        for (const id of sessionIds) {
            this.sessions.delete(id);
        }
        this._onDidChange.fire();
    }

    async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {return;}

        // Update the session in-memory
        const updatedSession: Session = {
            ...session,
            status,
            reason: undefined,
            lastUpdate: new Date().toISOString()
        };

        // Update the Map directly - no need to reload all sessions
        this.sessions.set(sessionId, updatedSession);

        // Write to file asynchronously
        const filePath = path.join(this.sessionsDirPath, `${sessionId}.json`);
        await fsPromises.writeFile(filePath, JSON.stringify(updatedSession));

        // Fire change event
        this._onDidChange.fire();
    }

    private isFilteringEnabled(): boolean {
        // When globalMode is true, filtering is disabled (show all sessions)
        // When globalMode is false (default), filtering is enabled (show only workspace sessions)
        return !vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('globalMode', false);
    }

    private isSessionInWorkspace(session: Session): boolean {
        if (!session.cwd) {
            return false;
        }
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return false;
        }
        const sessionPath = path.resolve(session.cwd);
        return workspaceFolders.some(folder =>
            sessionPath.startsWith(folder.uri.fsPath)
        );
    }

    private filterByWorkspace(sessions: Session[]): Session[] {
        if (!this.isFilteringEnabled()) {
            return sessions;
        }
        return sessions.filter(s => this.isSessionInWorkspace(s));
    }

    getAttentionRequired(): Session[] {
        const sessions = Array.from(this.sessions.values())
            .filter(s => s.status === 'attention')
            .sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime());
        return this.filterByWorkspace(sessions);
    }

    getIdle(): Session[] {
        const sessions = Array.from(this.sessions.values())
            .filter(s => s.status === 'idle')
            .sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime());
        return this.filterByWorkspace(sessions);
    }

    getRunning(): Session[] {
        const sessions = Array.from(this.sessions.values())
            .filter(s => s.status === 'running')
            .sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime());
        return this.filterByWorkspace(sessions);
    }

    getOther(): Session[] {
        if (!this.isFilteringEnabled()) {
            return [];
        }
        return Array.from(this.sessions.values())
            .filter(s => !s.cwd)
            .sort((a, b) => new Date(b.lastUpdate).getTime() - new Date(a.lastUpdate).getTime());
    }

    getAllSessions(): Session[] {
        return Array.from(this.sessions.values());
    }

    getSession(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
