import * as vscode from 'vscode';
import { exec } from 'child_process';
import { SessionManager } from './sessionManager';

// Debug logging - set to true for verbose console output
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
            const pid = this.extractPid(session.id);
            if (pid !== null) {
                pidsToCheck.push({ sessionId: session.id, pid });
            }
        }

        if (pidsToCheck.length === 0) {
            return { removedCount: 0, removedIds: [] };
        }

        // Batch check all PIDs at once
        const alivePids = await this.checkPidsAlive(pidsToCheck.map(p => p.pid));

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

    private extractPid(sessionId: string): number | null {
        const match = sessionId.match(/^ppid-(\d+)$/);
        return match ? parseInt(match[1], 10) : null;
    }

    /**
     * Check multiple PIDs at once and return a Set of alive PIDs.
     * Uses a single command for all PIDs instead of one per PID.
     */
    private async checkPidsAlive(pids: number[]): Promise<Set<number>> {
        const alivePids = new Set<number>();

        if (pids.length === 0) {
            return alivePids;
        }

        if (process.platform === 'win32') {
            // Windows: Use a single WMIC or PowerShell command to get all running PIDs
            return this.checkPidsAliveWindows(pids);
        } else {
            // Unix: Use process.kill(pid, 0) - fast and doesn't need shell
            for (const pid of pids) {
                try {
                    process.kill(pid, 0);
                    alivePids.add(pid);
                } catch {
                    // Process doesn't exist
                }
            }
            return alivePids;
        }
    }

    /**
     * Windows-specific batch PID check using a single PowerShell command.
     */
    private async checkPidsAliveWindows(pids: number[]): Promise<Set<number>> {
        return new Promise((resolve) => {
            const alivePids = new Set<number>();

            // Single PowerShell command to get all running process IDs
            // Then filter locally to check our PIDs
            const cmd = `powershell -NoProfile -Command "Get-Process | Select-Object -ExpandProperty Id"`;

            exec(cmd, { timeout: 5000 }, (error, stdout) => {
                if (error) {
                    // Fallback: assume all are dead if we can't check
                    if (DEBUG) {
                        console.log('[SessionCleaner] PowerShell failed, using fallback');
                    }
                    resolve(alivePids);
                    return;
                }

                // Parse the list of running PIDs
                const runningPids = new Set(
                    stdout.split(/\r?\n/)
                        .map(line => parseInt(line.trim(), 10))
                        .filter(pid => !isNaN(pid))
                );

                // Check which of our PIDs are in the running set
                for (const pid of pids) {
                    if (runningPids.has(pid)) {
                        alivePids.add(pid);
                    }
                }

                resolve(alivePids);
            });
        });
    }

    dispose(): void {
        this.stop();
    }
}
