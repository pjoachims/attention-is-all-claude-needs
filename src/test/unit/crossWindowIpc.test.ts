import { expect } from 'chai';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { createTestEnvironment, mockVscodeIpcHandle, restoreEnvironment, TestEnvironment } from '../helpers/testEnvironment';
import { createMultiWindowScenario, writeFocusRequest, MultiWindowScenario } from '../helpers/windowSimulator';
import { SessionManager } from '../../sessionManager';
import { CrossWindowIpc } from '../../crossWindowIpc';

describe('CrossWindowIpc', () => {
    let testEnv: TestEnvironment;
    let sessionManager: SessionManager;
    let crossWindowIpc: CrossWindowIpc;
    let scenario: MultiWindowScenario;

    // Mock dependencies
    const mockOutputChannel: vscode.OutputChannel = {
        name: 'test',
        appendLine: () => {},
        append: () => {},
        clear: () => {},
        show: () => {},
        hide: () => {},
        dispose: () => {},
        replace: () => {}
    };

    const mockMatchTerminal = async () => undefined;
    const mockClearAttention = async () => {};

    beforeEach(() => {
        testEnv = createTestEnvironment();
        scenario = createMultiWindowScenario(testEnv.sessionsDir);

        // Create sessions for both "windows"
        scenario.window1Sessions.forEach(s => scenario.simulator.sessionStart(s));
        scenario.window2Sessions.forEach(s => scenario.simulator.sessionStart(s));

        // Initialize with test paths
        sessionManager = new SessionManager(testEnv.sessionsDir);
        crossWindowIpc = new CrossWindowIpc(
            mockOutputChannel,
            mockMatchTerminal,
            mockClearAttention,
            { focusRequestFile: testEnv.focusRequestFile, monitorDir: testEnv.monitorDir }
        );
    });

    afterEach(() => {
        restoreEnvironment();
        testEnv.cleanup();
    });

    describe('Focus request routing', () => {
        it('should handle request targeting current window', async () => {
            mockVscodeIpcHandle(scenario.window1Handle);
            await sessionManager.loadSessions();

            writeFocusRequest(testEnv.focusRequestFile, {
                sessionId: 'ppid-1001',
                folder: '/projects/frontend',
                vscodeIpcHandle: scenario.window1Handle,
                timestamp: Date.now()
            });

            await crossWindowIpc.handleIncomingFocusRequest(sessionManager);

            // Request should be consumed (file deleted)
            expect(fs.existsSync(testEnv.focusRequestFile)).to.be.false;
        });

        it('should ignore request targeting different window', async () => {
            mockVscodeIpcHandle(scenario.window1Handle);
            await sessionManager.loadSessions();

            writeFocusRequest(testEnv.focusRequestFile, {
                sessionId: 'ppid-2001',
                folder: '/projects/backend',
                vscodeIpcHandle: scenario.window2Handle,
                timestamp: Date.now()
            });

            await crossWindowIpc.handleIncomingFocusRequest(sessionManager);

            // Request should NOT be consumed (file still exists)
            expect(fs.existsSync(testEnv.focusRequestFile)).to.be.true;
        });

        it('should delete stale requests (>5 seconds old)', async () => {
            mockVscodeIpcHandle(scenario.window1Handle);
            await sessionManager.loadSessions();

            writeFocusRequest(testEnv.focusRequestFile, {
                sessionId: 'ppid-1001',
                folder: '/projects/frontend',
                vscodeIpcHandle: scenario.window1Handle,
                timestamp: Date.now() - 10000 // 10 seconds ago
            });

            await crossWindowIpc.handleIncomingFocusRequest(sessionManager);

            // Stale request should be deleted
            expect(fs.existsSync(testEnv.focusRequestFile)).to.be.false;
        });

        it('should handle missing focus request file', async () => {
            mockVscodeIpcHandle(scenario.window1Handle);
            await sessionManager.loadSessions();

            // No focus request file exists
            expect(fs.existsSync(testEnv.focusRequestFile)).to.be.false;

            // Should not throw
            await crossWindowIpc.handleIncomingFocusRequest(sessionManager);
        });

        it('should handle malformed focus request file', async () => {
            mockVscodeIpcHandle(scenario.window1Handle);
            await sessionManager.loadSessions();

            // Write invalid JSON
            fs.writeFileSync(testEnv.focusRequestFile, 'not valid json');

            // Should not throw
            await crossWindowIpc.handleIncomingFocusRequest(sessionManager);
        });
    });

    describe('Multi-session scenarios', () => {
        it('should load sessions from multiple windows', async () => {
            await sessionManager.loadSessions();
            const sessions = sessionManager.getAllSessions();

            expect(sessions).to.have.lengthOf(3); // 2 from window1 + 1 from window2
        });

        it('should differentiate sessions by IPC handle', async () => {
            await sessionManager.loadSessions();
            const sessions = sessionManager.getAllSessions();

            const window1Sessions = sessions.filter(s => s.vscodeIpcHandle === scenario.window1Handle);
            const window2Sessions = sessions.filter(s => s.vscodeIpcHandle === scenario.window2Handle);

            expect(window1Sessions).to.have.lengthOf(2);
            expect(window2Sessions).to.have.lengthOf(1);
        });

        it('should correctly identify session by ID', async () => {
            await sessionManager.loadSessions();

            const session = sessionManager.getSession('ppid-1001');
            expect(session).to.not.be.undefined;
            expect(session!.cwd).to.equal('/projects/frontend');
            expect(session!.vscodeIpcHandle).to.equal(scenario.window1Handle);
        });

        it('should return undefined for non-existent session', async () => {
            await sessionManager.loadSessions();

            const session = sessionManager.getSession('ppid-9999');
            expect(session).to.be.undefined;
        });
    });

    describe('Session lifecycle', () => {
        it('should detect new sessions after reload', async () => {
            await sessionManager.loadSessions();
            expect(sessionManager.getAllSessions()).to.have.lengthOf(3);

            // Add a new session
            scenario.simulator.sessionStart({
                id: 'ppid-3001',
                cwd: '/projects/new-project',
                terminalPid: 3002,
                vscodeIpcHandle: scenario.window1Handle
            });

            await sessionManager.loadSessions();
            expect(sessionManager.getAllSessions()).to.have.lengthOf(4);
        });

        it('should detect removed sessions after reload', async () => {
            await sessionManager.loadSessions();
            expect(sessionManager.getAllSessions()).to.have.lengthOf(3);

            // End a session
            scenario.simulator.sessionEnd({ id: 'ppid-1001' });

            await sessionManager.loadSessions();
            expect(sessionManager.getAllSessions()).to.have.lengthOf(2);
            expect(sessionManager.getSession('ppid-1001')).to.be.undefined;
        });

        it('should track status changes', async () => {
            await sessionManager.loadSessions();

            // Initially running
            let session = sessionManager.getSession('ppid-1001');
            expect(session!.status).to.equal('running');

            // Trigger attention
            scenario.simulator.attention({ id: 'ppid-1001', cwd: '/projects/frontend' });
            await sessionManager.loadSessions();

            session = sessionManager.getSession('ppid-1001');
            expect(session!.status).to.equal('attention');
            expect(session!.reason).to.equal('permission_prompt');

            // Go idle
            scenario.simulator.idle({ id: 'ppid-1001', cwd: '/projects/frontend' });
            await sessionManager.loadSessions();

            session = sessionManager.getSession('ppid-1001');
            expect(session!.status).to.equal('idle');
        });
    });

    describe('Focus request file path configuration', () => {
        it('should use configured focus request file path', () => {
            const customPath = testEnv.focusRequestFile;
            expect(crossWindowIpc.getFocusRequestFilePath()).to.equal(customPath);
        });
    });
});
