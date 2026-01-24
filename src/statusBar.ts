import * as vscode from 'vscode';
import { Session } from './sessionManager';

/**
 * Manages the status bar items for Claude session monitoring.
 * Creates and updates status bar items showing attention, idle, and running counts.
 */
export class StatusBarManager implements vscode.Disposable {
    private sbClaude: vscode.StatusBarItem;
    private sbAttention: vscode.StatusBarItem;
    private sbIdle: vscode.StatusBarItem;
    private sbRunning: vscode.StatusBarItem;

    constructor() {
        // Create status bar items (priority determines order, higher = more left)
        // Order: claude, attention, idle, running
        this.sbClaude = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 104);
        this.sbClaude.command = 'claude-monitor.manageAssociations';
        this.sbClaude.text = '$(hubot)';
        this.sbClaude.tooltip = 'Claude Sessions';
        this.sbClaude.show();

        this.sbAttention = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
        this.sbAttention.command = 'claude-monitor.clickAttention';
        this.sbAttention.show();

        this.sbIdle = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
        this.sbIdle.command = 'claude-monitor.clickIdle';
        this.sbIdle.show();

        this.sbRunning = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
        this.sbRunning.command = 'claude-monitor.clickRunning';
        this.sbRunning.show();
    }

    /**
     * Update the status bar based on current sessions.
     * @param sessions - Array of sessions to count by status
     * @param globalMode - Whether global mode is enabled
     */
    update(sessions: Session[], globalMode: boolean): void {
        // Count each status in a single pass
        let attention = 0;
        let idle = 0;
        let running = 0;
        for (const session of sessions) {
            switch (session.status) {
                case 'attention': attention++; break;
                case 'idle': idle++; break;
                case 'running': running++; break;
            }
        }

        const modeText = globalMode ? 'Global' : 'Workspace';

        // Attention indicator
        this.sbAttention.text = `$(bell-dot) ${attention}`;
        this.sbAttention.tooltip = `${attention} session(s) need attention (${modeText})`;
        if (attention > 0) {
            this.sbAttention.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.sbAttention.backgroundColor = undefined;
        }

        // Idle indicator
        this.sbIdle.text = `$(clock) ${idle}`;
        this.sbIdle.tooltip = `${idle} session(s) idle (${modeText})`;
        this.sbIdle.backgroundColor = undefined;

        // Running indicator
        this.sbRunning.text = `$(play) ${running}`;
        this.sbRunning.tooltip = `${running} session(s) running (${modeText})`;
        this.sbRunning.backgroundColor = undefined;
    }

    dispose(): void {
        this.sbClaude.dispose();
        this.sbAttention.dispose();
        this.sbIdle.dispose();
        this.sbRunning.dispose();
    }
}
