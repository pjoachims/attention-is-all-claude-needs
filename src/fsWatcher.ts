import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const DEBUG = false;

export interface FSWatcherOptions {
    /** Watch mode: 'directory' watches all files in a directory, 'file' watches a single file */
    mode: 'directory' | 'file';
    /** Debounce interval in milliseconds (default: 50 for directory, 100 for file) */
    debounceMs?: number;
    /** File extension filter for directory mode (e.g., '.json'). Only fires for matching files. */
    fileFilter?: string;
}

/**
 * Unified file system watcher for both directory and single-file watching.
 * Replaces both DirectoryWatcher and FileWatcher with a single configurable class.
 */
export class FSWatcher implements vscode.Disposable {
    private watcher: fs.FSWatcher | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private readonly debounceMs: number;
    private readonly mode: 'directory' | 'file';
    private readonly fileFilter?: string;
    private readonly watchPath: string;
    private readonly watchDir: string;
    private readonly watchFileName?: string;

    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(watchPath: string, options: FSWatcherOptions) {
        this.watchPath = watchPath;
        this.mode = options.mode;
        this.fileFilter = options.fileFilter;
        this.debounceMs = options.debounceMs ?? (options.mode === 'directory' ? 50 : 100);

        if (options.mode === 'file') {
            this.watchDir = path.dirname(watchPath);
            this.watchFileName = path.basename(watchPath);
        } else {
            this.watchDir = watchPath;
        }
    }

    /**
     * Start watching for changes.
     */
    start(): void {
        this.ensureDirectoryExists();
        this.setupWatcher();
    }

    /**
     * Stop watching and clean up resources.
     */
    stop(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
    }

    private ensureDirectoryExists(): void {
        if (!fs.existsSync(this.watchDir)) {
            fs.mkdirSync(this.watchDir, { recursive: true });
        }
    }

    private setupWatcher(): void {
        try {
            this.watcher = fs.watch(this.watchDir, (eventType, filename) => {
                if (this.shouldHandleChange(filename)) {
                    this.handleChange();
                }
            });

            this.watcher.on('error', (error) => {
                if (DEBUG) {
                    console.error(`FSWatcher error (${this.mode}):`, error);
                }
                this.restartWatcher();
            });
        } catch (error) {
            if (DEBUG) {
                console.error(`Failed to start FSWatcher (${this.mode}):`, error);
            }
        }
    }

    private shouldHandleChange(filename: string | null): boolean {
        // File mode: only handle changes to the specific file
        if (this.mode === 'file') {
            // On Windows, filename is often null - fall back to checking if file exists
            if (!filename) {
                return fs.existsSync(this.watchPath);
            }
            // Case-insensitive comparison for Windows
            return filename.toLowerCase() === this.watchFileName?.toLowerCase();
        }

        // Directory mode
        if (!filename) {
            return false;
        }

        // Optionally filter by extension
        if (this.fileFilter) {
            return filename.toLowerCase().endsWith(this.fileFilter.toLowerCase());
        }

        return true;
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
        this.stop();
        this._onDidChange.dispose();
    }
}

/**
 * Creates a directory watcher that monitors all .json files in a directory.
 * Convenience factory function for session file watching.
 */
export function createDirectoryWatcher(dirPath: string, debounceMs = 50): FSWatcher {
    return new FSWatcher(dirPath, {
        mode: 'directory',
        debounceMs,
        fileFilter: '.json'
    });
}

/**
 * Creates a file watcher that monitors a single file.
 * Convenience factory function for focus request file watching.
 */
export function createFileWatcher(filePath: string, debounceMs = 100): FSWatcher {
    return new FSWatcher(filePath, {
        mode: 'file',
        debounceMs
    });
}
