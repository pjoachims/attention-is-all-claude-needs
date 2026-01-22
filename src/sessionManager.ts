import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { AtomicFileOps } from './atomicFileOps';

export type SessionStatus = 'attention' | 'running' | 'idle';

export interface Session {
    id: string;
    status: SessionStatus;
    reason?: string;
    cwd?: string;
    lastUpdate: string;
}

export interface SessionsData {
    sessions: Record<string, Session>;
}

export class SessionManager {
    private sessions: Map<string, Session> = new Map();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private readonly sessionsFilePath: string;
    private readonly fileOps: AtomicFileOps;

    constructor() {
        this.sessionsFilePath = path.join(
            os.homedir(),
            '.claude',
            'attention-monitor',
            'sessions.json'
        );
        this.fileOps = new AtomicFileOps(this.sessionsFilePath);
    }

    getSessionsFilePath(): string {
        return this.sessionsFilePath;
    }

    async loadSessions(): Promise<void> {
        try {
            const data = await this.fileOps.readJson<SessionsData>();

            this.sessions.clear();
            if (data && data.sessions) {
                for (const [id, session] of Object.entries(data.sessions)) {
                    this.sessions.set(id, session);
                }
            }

            this._onDidChange.fire();
        } catch (error) {
            console.error('Failed to load sessions:', error);
            this.sessions.clear();
            this._onDidChange.fire();
        }
    }

    async removeSession(sessionId: string): Promise<void> {
        await this.removeSessions([sessionId]);
    }

    async removeSessions(sessionIds: string[]): Promise<void> {
        if (sessionIds.length === 0) {
            return;
        }

        const idsToRemove = new Set(sessionIds);

        await this.fileOps.modifyJson<SessionsData>((data) => {
            if (!data || !data.sessions) {
                return data;
            }

            for (const id of idsToRemove) {
                delete data.sessions[id];
            }

            return data;
        });

        // Reload to update local state
        await this.loadSessions();
    }

    async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
        await this.fileOps.modifyJson<SessionsData>((data) => {
            if (!data || !data.sessions || !data.sessions[sessionId]) {
                return data;
            }

            data.sessions[sessionId].status = status;
            data.sessions[sessionId].reason = undefined;
            data.sessions[sessionId].lastUpdate = new Date().toISOString();

            return data;
        });

        // Reload to update local state
        await this.loadSessions();
    }

    private isFilteringEnabled(): boolean {
        return vscode.workspace.getConfiguration('claudeMonitor').get<boolean>('filterByWorkspace', true);
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
