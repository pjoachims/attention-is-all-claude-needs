import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export type SessionStatus = 'attention' | 'running' | 'idle';

export interface Session {
    id: string;
    status: SessionStatus;
    reason?: string;
    cwd?: string;
    lastUpdate: string;
}

export class SessionManager {
    private sessions: Map<string, Session> = new Map();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    private readonly sessionsDirPath: string;

    constructor() {
        this.sessionsDirPath = path.join(
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

            console.log(`[SessionManager] Loading from: ${this.sessionsDirPath}`);
            console.log(`[SessionManager] Directory exists: ${fs.existsSync(this.sessionsDirPath)}`);

            if (!fs.existsSync(this.sessionsDirPath)) {
                fs.mkdirSync(this.sessionsDirPath, { recursive: true });
                this._onDidChange.fire();
                return;
            }

            const files = fs.readdirSync(this.sessionsDirPath);
            console.log(`[SessionManager] Found ${files.length} files: ${files.join(', ')}`);

            for (const file of files) {
                if (!file.endsWith('.json')) {continue;}

                try {
                    const filePath = path.join(this.sessionsDirPath, file);
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const session: Session = JSON.parse(content);
                    if (session.id && session.status) {
                        this.sessions.set(session.id, session);
                        console.log(`[SessionManager] Loaded session: ${session.id} (${session.status})`);
                    }
                } catch (e) {
                    console.error(`[SessionManager] Failed to parse ${file}:`, e);
                }
            }

            console.log(`[SessionManager] Total sessions loaded: ${this.sessions.size}`);
            this._onDidChange.fire();
        } catch (error) {
            console.error('[SessionManager] Failed to load sessions:', error);
            this.sessions.clear();
            this._onDidChange.fire();
        }
    }

    async removeSession(sessionId: string): Promise<void> {
        await this.removeSessions([sessionId]);
    }

    async removeSessions(sessionIds: string[]): Promise<void> {
        for (const id of sessionIds) {
            const filePath = path.join(this.sessionsDirPath, `${id}.json`);
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch {
                // Ignore errors
            }
        }
        await this.loadSessions();
    }

    async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session) {return;}

        session.status = status;
        session.reason = undefined;
        session.lastUpdate = new Date().toISOString();

        const filePath = path.join(this.sessionsDirPath, `${sessionId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(session));

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
