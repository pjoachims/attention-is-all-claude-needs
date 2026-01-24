import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TestEnvironment {
    sessionsDir: string;
    focusRequestFile: string;
    monitorDir: string;
    cleanup(): void;
}

/**
 * Creates an isolated test environment with temporary directories.
 * Call cleanup() in afterEach to remove the temp files.
 */
export function createTestEnvironment(): TestEnvironment {
    const monitorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-attn-test-'));
    const sessionsDir = path.join(monitorDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    return {
        monitorDir,
        sessionsDir,
        focusRequestFile: path.join(monitorDir, 'focus-request.json'),
        cleanup() {
            fs.rmSync(monitorDir, { recursive: true, force: true });
        }
    };
}

let originalIpcHandle: string | undefined;

/**
 * Mock the VSCODE_GIT_IPC_HANDLE environment variable.
 * Call restoreEnvironment() in afterEach to restore the original value.
 */
export function mockVscodeIpcHandle(handle: string): void {
    originalIpcHandle = process.env.VSCODE_GIT_IPC_HANDLE;
    process.env.VSCODE_GIT_IPC_HANDLE = handle;
}

/**
 * Restore the original VSCODE_GIT_IPC_HANDLE environment variable.
 */
export function restoreEnvironment(): void {
    if (originalIpcHandle !== undefined) {
        process.env.VSCODE_GIT_IPC_HANDLE = originalIpcHandle;
    } else {
        delete process.env.VSCODE_GIT_IPC_HANDLE;
    }
    originalIpcHandle = undefined;
}
