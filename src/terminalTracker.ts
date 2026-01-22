import * as vscode from 'vscode';

/**
 * Tracks associations between Claude sessions and VS Code terminals.
 * Uses PID matching to automatically link sessions to terminals.
 */
class TerminalTracker {
    private sessionToTerminal = new Map<string, vscode.Terminal>();
    private terminalToSession = new Map<vscode.Terminal, string>();

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    /**
     * Get the terminal associated with a session
     */
    getTerminalForSession(sessionId: string): vscode.Terminal | undefined {
        const terminal = this.sessionToTerminal.get(sessionId);
        // Verify terminal still exists
        if (terminal && vscode.window.terminals.includes(terminal)) {
            return terminal;
        }
        return undefined;
    }

    /**
     * Get the terminal name for a session (for display purposes)
     */
    getTerminalNameForSession(sessionId: string): string | undefined {
        const terminal = this.getTerminalForSession(sessionId);
        return terminal?.name;
    }

    /**
     * Get the session ID associated with a terminal
     */
    getSessionForTerminal(terminal: vscode.Terminal): string | undefined {
        return this.terminalToSession.get(terminal);
    }

    /**
     * Associate a session with a terminal
     */
    associate(sessionId: string, terminal: vscode.Terminal): void {
        // Remove any existing associations for this terminal
        const oldSessionId = this.terminalToSession.get(terminal);
        if (oldSessionId) {
            this.sessionToTerminal.delete(oldSessionId);
        }

        // Remove any existing terminal for this session
        const oldTerminal = this.sessionToTerminal.get(sessionId);
        if (oldTerminal) {
            this.terminalToSession.delete(oldTerminal);
        }

        this.sessionToTerminal.set(sessionId, terminal);
        this.terminalToSession.set(terminal, sessionId);
        this._onDidChange.fire();
    }

    /**
     * Remove association for a session
     */
    removeSession(sessionId: string): void {
        const terminal = this.sessionToTerminal.get(sessionId);
        if (terminal) {
            this.terminalToSession.delete(terminal);
        }
        this.sessionToTerminal.delete(sessionId);
        this._onDidChange.fire();
    }

    /**
     * Remove association for a terminal (e.g., when terminal closes)
     */
    removeTerminal(terminal: vscode.Terminal): void {
        const sessionId = this.terminalToSession.get(terminal);
        if (sessionId) {
            this.sessionToTerminal.delete(sessionId);
        }
        this.terminalToSession.delete(terminal);
        this._onDidChange.fire();
    }

    /**
     * Check if a session has an associated terminal
     */
    hasTerminal(sessionId: string): boolean {
        return this.getTerminalForSession(sessionId) !== undefined;
    }

    /**
     * Get all session IDs that have terminal associations
     */
    getAssociatedSessionIds(): string[] {
        return Array.from(this.sessionToTerminal.keys());
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}

// Singleton instance
export const terminalTracker = new TerminalTracker();
