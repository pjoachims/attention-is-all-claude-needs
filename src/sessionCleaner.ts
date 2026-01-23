import * as vscode from 'vscode';
import { SessionManager } from './sessionManager';

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
        const deadSessionIds: string[] = [];

        for (const session of sessions) {
            const pid = this.extractPid(session.id);
            if (pid !== null) {
                const alive = this.isProcessAlive(pid);
                console.log(`[SessionCleaner] Checking ${session.id} (PID ${pid}): alive=${alive}`);
                if (!alive) {
                    deadSessionIds.push(session.id);
                }
            }
        }

        if (deadSessionIds.length > 0) {
            console.log(`[SessionCleaner] Removing dead sessions: ${deadSessionIds.join(', ')}`);
            await this.sessionManager.removeSessions(deadSessionIds);
        }

        return {
            removedCount: deadSessionIds.length,
            removedIds: deadSessionIds
        };
    }

    private extractPid(sessionId: string): number | null {
        const match = sessionId.match(/^ppid-(\d+)$/);
        return match ? parseInt(match[1], 10) : null;
    }

    private isProcessAlive(pid: number): boolean {
        try {
            if (process.platform === 'win32') {
                // On Windows, process.kill(pid, 0) doesn't work reliably
                // Use synchronous exec to check via tasklist
                const { execSync } = require('child_process');
                try {
                    const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
                    // If process exists, tasklist returns a line with the PID
                    return result.includes(String(pid));
                } catch {
                    return false;
                }
            } else {
                // Signal 0 checks if process exists without actually sending a signal
                process.kill(pid, 0);
                return true;
            }
        } catch {
            return false;
        }
    }

    dispose(): void {
        this.stop();
    }
}
