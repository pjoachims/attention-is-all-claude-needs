import * as fs from 'fs';
import { HookSimulator, SimulatedSession } from './hookSimulator';

export interface FocusRequest {
    sessionId: string;
    folder: string;
    vscodeIpcHandle: string;
    timestamp: number;
}

export interface MultiWindowScenario {
    window1Handle: string;
    window2Handle: string;
    simulator: HookSimulator;
    window1Sessions: SimulatedSession[];
    window2Sessions: SimulatedSession[];
}

/**
 * Creates a simulated multi-window scenario with sessions distributed across two windows.
 * Each window has a unique IPC handle.
 */
export function createMultiWindowScenario(sessionsDir: string): MultiWindowScenario {
    const window1Handle = '/tmp/vscode-ipc-window1.sock';
    const window2Handle = '/tmp/vscode-ipc-window2.sock';
    const simulator = new HookSimulator(sessionsDir);

    return {
        window1Handle,
        window2Handle,
        simulator,
        // Sessions for window 1
        window1Sessions: [
            { id: 'ppid-1001', cwd: '/projects/frontend', terminalPid: 1002, vscodeIpcHandle: window1Handle },
            { id: 'ppid-1003', cwd: '/projects/frontend/api', terminalPid: 1004, vscodeIpcHandle: window1Handle }
        ] as SimulatedSession[],
        // Sessions for window 2
        window2Sessions: [
            { id: 'ppid-2001', cwd: '/projects/backend', terminalPid: 2002, vscodeIpcHandle: window2Handle }
        ] as SimulatedSession[]
    };
}

/**
 * Write a focus request to the given file path.
 */
export function writeFocusRequest(filePath: string, request: FocusRequest): void {
    fs.writeFileSync(filePath, JSON.stringify(request));
}

/**
 * Read and parse a focus request from the given file path.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readFocusRequest(filePath: string): FocusRequest | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}
