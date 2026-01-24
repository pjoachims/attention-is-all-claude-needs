import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';
import { checkPidsAlive, extractPidFromSessionId } from './platform';

const DEBUG = false;

export interface CleanupResult {
    removedCount: number;
    removedIds: string[];
}

export class SessionCleaner implements vscode.Disposable {
    private readonly sessionManager: SessionManager;
    private intervalHandle: NodeJS.Timeout | null = null;
    private readonly defaultIntervalSeconds = 30;

    constructor(sessionManager: SessionManager) {
        this.sessionManager = sessionManager;
    }

    start(): void {
        if (this.intervalHandle) {
            return; // Already running
        }

        const intervalSeconds = vscode.workspace
            .getConfiguration('claudeMonitor')
            .get<number>('cleanupInterval', this.defaultIntervalSeconds);

        const intervalMs = intervalSeconds * 1000;

        this.intervalHandle = setInterval(async () => {
            await this.cleanupNow();
        }, intervalMs);
    }

    stop(): void {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

    async cleanupNow(): Promise<CleanupResult> {
        const sessions = this.sessionManager.getAllSessions();
        const pidsToCheck: { sessionId: string; pid: number }[] = [];

        for (const session of sessions) {
            const pid = extractPidFromSessionId(session.id);
            if (pid !== null) {
                pidsToCheck.push({ sessionId: session.id, pid });
            }
        }

        if (pidsToCheck.length === 0) {
            return { removedCount: 0, removedIds: [] };
        }

        // Batch check all PIDs at once
        const alivePids = await checkPidsAlive(pidsToCheck.map(p => p.pid));

        const deadSessionIds: string[] = [];
        for (const { sessionId, pid } of pidsToCheck) {
            const alive = alivePids.has(pid);
            if (DEBUG) {
                console.log(`[SessionCleaner] Checking ${sessionId} (PID ${pid}): alive=${alive}`);
            }
            if (!alive) {
                deadSessionIds.push(sessionId);
            }
        }

        if (deadSessionIds.length > 0) {
            if (DEBUG) {
                console.log(`[SessionCleaner] Removing dead sessions: ${deadSessionIds.join(', ')}`);
            }
            await this.sessionManager.removeSessions(deadSessionIds);
        }

        return {
            removedCount: deadSessionIds.length,
            removedIds: deadSessionIds
        };
    }

    dispose(): void {
        this.stop();
    }
}
