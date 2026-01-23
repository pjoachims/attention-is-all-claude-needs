import * as vscode from 'vscode';
import * as fs from 'fs';

/**
 * Watches a directory for any file changes (add, modify, delete).
 * Used for the per-session file storage approach.
 */
export class DirectoryWatcher implements vscode.Disposable {
    private watcher: fs.FSWatcher | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private readonly debounceMs = 50; // Faster than file watcher since writes are atomic

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly dirPath: string) {}

    start(): void {
        this.ensureDirectoryExists();
        this.setupWatcher();
    }

    private ensureDirectoryExists(): void {
        if (!fs.existsSync(this.dirPath)) {
            fs.mkdirSync(this.dirPath, { recursive: true });
        }
    }

    private setupWatcher(): void {
        try {
            this.watcher = fs.watch(this.dirPath, (eventType, filename) => {
                // Only care about .json files
                if (filename && filename.endsWith('.json')) {
                    this.handleChange();
                }
            });

            this.watcher.on('error', (error) => {
                console.error('Directory watcher error:', error);
                this.restartWatcher();
            });
        } catch (error) {
            console.error('Failed to start directory watcher:', error);
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
