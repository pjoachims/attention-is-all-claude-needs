import { exec } from 'child_process';

const DEBUG = false;

// Platform detection constants
export const isWindows = process.platform === 'win32';
export const isMacOS = process.platform === 'darwin';
export const isLinux = process.platform === 'linux';

/**
 * Extract PID from session ID (format: "ppid-12345")
 */
export function extractPidFromSessionId(sessionId: string): number | null {
    const match = sessionId.match(/^ppid-(\d+)$/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Check multiple PIDs at once and return a Set of alive PIDs.
 * Uses a single command for all PIDs instead of one per PID.
 */
export async function checkPidsAlive(pids: number[]): Promise<Set<number>> {
    const alivePids = new Set<number>();

    if (pids.length === 0) {
        return alivePids;
    }

    if (isWindows) {
        return checkPidsAliveWindows(pids);
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
async function checkPidsAliveWindows(pids: number[]): Promise<Set<number>> {
    return new Promise((resolve) => {
        const alivePids = new Set<number>();

        // Single PowerShell command to get all running process IDs
        // Then filter locally to check our PIDs
        const cmd = `powershell -NoProfile -Command "Get-Process | Select-Object -ExpandProperty Id"`;

        exec(cmd, { timeout: 5000 }, (error, stdout) => {
            if (error) {
                if (DEBUG) {
                    console.log('[checkPidsAliveWindows] PowerShell failed, using fallback');
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
