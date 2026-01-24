import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SimulatedSession {
    id: string;
    cwd?: string;
    terminalPid?: number;
    vscodeIpcHandle?: string;
}

/**
 * Simulates Claude hook events by writing session JSON files.
 * Used for E2E and integration testing.
 */
export class HookSimulator {
    private readonly sessionsDir: string;

    constructor(sessionsDir?: string) {
        this.sessionsDir = sessionsDir ?? path.join(os.homedir(), '.claude', 'claude-attn', 'sessions');
    }

    /**
     * Ensure the sessions directory exists.
     */
    ensureDir(): void {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    /**
     * Simulate a session start event (status: running).
     */
    sessionStart(session: SimulatedSession): void {
        this.writeSession(session, 'running');
    }

    /**
     * Simulate an attention event (status: attention).
     */
    attention(session: SimulatedSession, reason = 'permission_prompt'): void {
        this.writeSession(session, 'attention', reason);
    }

    /**
     * Simulate an idle event (status: idle).
     */
    idle(session: SimulatedSession): void {
        this.writeSession(session, 'idle');
    }

    /**
     * Simulate a session end event (delete session file).
     */
    sessionEnd(session: SimulatedSession): void {
        const filePath = path.join(this.sessionsDir, `${session.id}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    /**
     * Write a session file with the given status.
     */
    private writeSession(
        session: SimulatedSession,
        status: 'running' | 'attention' | 'idle',
        reason?: string
    ): void {
        this.ensureDir();

        const data = {
            id: session.id,
            status,
            reason,
            cwd: session.cwd,
            terminalPid: session.terminalPid,
            vscodeIpcHandle: session.vscodeIpcHandle,
            lastUpdate: new Date().toISOString()
        };

        const filePath = path.join(this.sessionsDir, `${session.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }

    /**
     * Clear all session files.
     */
    clearAll(): void {
        if (fs.existsSync(this.sessionsDir)) {
            const files = fs.readdirSync(this.sessionsDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    fs.unlinkSync(path.join(this.sessionsDir, file));
                }
            }
        }
    }

    /**
     * Get all current session files.
     */
    getAllSessions(): string[] {
        if (!fs.existsSync(this.sessionsDir)) {
            return [];
        }
        return fs.readdirSync(this.sessionsDir)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    }
}

/**
 * Create a simulated session with a unique ID.
 */
export function createSimulatedSession(pid: number, cwd?: string): SimulatedSession {
    return {
        id: `ppid-${pid}`,
        cwd,
        terminalPid: pid + 1
    };
}
