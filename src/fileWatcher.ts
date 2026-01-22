import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class FileWatcher implements vscode.Disposable {
    private watcher: fs.FSWatcher | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private readonly debounceMs = 100;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly filePath: string) {}

    start(): void {
        this.ensureDirectoryExists();
        this.setupWatcher();
    }

    private ensureDirectoryExists(): void {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private setupWatcher(): void {
        const dir = path.dirname(this.filePath);
        const fileName = path.basename(this.filePath);

        try {
            this.watcher = fs.watch(dir, (eventType, filename) => {
                if (filename === fileName) {
                    this.handleChange();
                }
            });

            this.watcher.on('error', (error) => {
                console.error('File watcher error:', error);
                this.restartWatcher();
            });
        } catch (error) {
            console.error('Failed to start file watcher:', error);
        }
    }

    private handleChange(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this._onDidChange.fire();
        }, this.debounceMs);
    }

    private restartWatcher(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }

        setTimeout(() => {
            this.setupWatcher();
        }, 1000);
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        if (this.watcher) {
            this.watcher.close();
        }
        this._onDidChange.dispose();
    }
}
