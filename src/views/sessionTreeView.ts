import * as vscode from 'vscode';
import * as path from 'path';
import { SessionManager, Session, SessionStatus } from '../sessionManager';
import { aliasManager } from '../aliasManager';
import { terminalTracker } from '../terminalTracker';

type TreeItemType = 'category' | 'session';

export class SessionItem extends vscode.TreeItem {
    constructor(
        public readonly itemType: TreeItemType,
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly session?: Session
    ) {
        super(label, collapsibleState);

        if (itemType === 'session' && session) {
            this.contextValue = 'session';
            this.description = this.getDescription(session);
            this.tooltip = this.getTooltip(session);
            this.iconPath = this.getIcon(session.status);
            this.command = {
                command: 'claude-monitor.focusSession',
                title: 'Focus Session',
                arguments: [session]
            };
        } else if (itemType === 'category') {
            this.contextValue = 'category';
        }
    }

    private getDescription(session: Session): string {
        const parts: string[] = [];

        // Show terminal association
        const terminalName = terminalTracker.getTerminalNameForSession(session.id);
        if (terminalName) {
            parts.push(`→ ${terminalName}`);
        }

        if (session.reason) {
            parts.push(session.reason.replace(/_/g, ' '));
        }

        return parts.join(' · ');
    }

    private getTooltip(session: Session): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**Session:** ${session.id}\n\n`);
        md.appendMarkdown(`**Status:** ${session.status}\n\n`);

        const terminalName = terminalTracker.getTerminalNameForSession(session.id);
        if (terminalName) {
            md.appendMarkdown(`**Terminal:** ${terminalName}\n\n`);
        }

        if (session.reason) {
            md.appendMarkdown(`**Reason:** ${session.reason}\n\n`);
        }
        if (session.cwd) {
            md.appendMarkdown(`**Directory:** ${session.cwd}\n\n`);
        }
        md.appendMarkdown(`**Last Update:** ${new Date(session.lastUpdate).toLocaleString()}`);
        return md;
    }

    private getIcon(status: SessionStatus): vscode.ThemeIcon {
        switch (status) {
            case 'attention':
                return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('charts.red'));
            case 'running':
                return new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green'));
            case 'idle':
                return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.yellow'));
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly sessionManager: SessionManager) {
        sessionManager.onDidChange(() => this.refresh());
        // Refresh when terminal associations change
        terminalTracker.onDidChange(() => this.refresh());
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SessionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SessionItem): Thenable<SessionItem[]> {
        if (!element) {
            return Promise.resolve(this.getRootItems());
        }

        if (element.itemType === 'category') {
            if (element.label === 'Attention Required') {
                return Promise.resolve(this.getAttentionItems());
            } else if (element.label === 'Idle') {
                return Promise.resolve(this.getIdleItems());
            } else if (element.label === 'Running') {
                return Promise.resolve(this.getRunningItems());
            } else if (element.label === 'Other') {
                return Promise.resolve(this.getOtherItems());
            }
        }

        return Promise.resolve([]);
    }

    private getRootItems(): SessionItem[] {
        const attentionCount = this.sessionManager.getAttentionRequired().length;
        const idleCount = this.sessionManager.getIdle().length;
        const runningCount = this.sessionManager.getRunning().length;
        const otherCount = this.sessionManager.getOther().length;

        const items = [
            new SessionItem(
                'category',
                `Attention Required`,
                attentionCount > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
            ),
            new SessionItem(
                'category',
                `Idle`,
                idleCount > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
            ),
            new SessionItem(
                'category',
                `Running`,
                runningCount > 0
                    ? vscode.TreeItemCollapsibleState.Expanded
                    : vscode.TreeItemCollapsibleState.Collapsed
            )
        ];

        // Only show "Other" category when filtering is enabled and there are sessions without cwd
        if (otherCount > 0) {
            items.push(new SessionItem(
                'category',
                `Other`,
                vscode.TreeItemCollapsibleState.Collapsed
            ));
        }

        return items;
    }

    private getAttentionItems(): SessionItem[] {
        return this.sessionManager.getAttentionRequired().map(session =>
            new SessionItem(
                'session',
                this.getSessionLabel(session),
                vscode.TreeItemCollapsibleState.None,
                session
            )
        );
    }

    private getIdleItems(): SessionItem[] {
        return this.sessionManager.getIdle().map(session =>
            new SessionItem(
                'session',
                this.getSessionLabel(session),
                vscode.TreeItemCollapsibleState.None,
                session
            )
        );
    }

    private getRunningItems(): SessionItem[] {
        return this.sessionManager.getRunning().map(session =>
            new SessionItem(
                'session',
                this.getSessionLabel(session),
                vscode.TreeItemCollapsibleState.None,
                session
            )
        );
    }

    private getOtherItems(): SessionItem[] {
        return this.sessionManager.getOther().map(session =>
            new SessionItem(
                'session',
                this.getSessionLabel(session),
                vscode.TreeItemCollapsibleState.None,
                session
            )
        );
    }

    private getSessionLabel(session: Session): string {
        // Check for user-defined alias first
        if (session.cwd) {
            const alias = aliasManager.get(session.cwd);
            if (alias) {
                return alias;
            }
            return path.basename(session.cwd);
        }
        return session.id.substring(0, 8);
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
