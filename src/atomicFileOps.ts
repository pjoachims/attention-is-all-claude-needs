import * as fs from 'fs';
import * as path from 'path';

export class AtomicFileOps {
    private readonly targetPath: string;
    private readonly lockPath: string;
    private readonly lockTimeout = 10000; // 10 seconds

    constructor(targetPath: string) {
        this.targetPath = targetPath;
        this.lockPath = targetPath + '.lock';
    }

    async readJson<T>(): Promise<T | null> {
        try {
            if (!fs.existsSync(this.targetPath)) {
                return null;
            }

            const content = fs.readFileSync(this.targetPath, 'utf-8');
            return JSON.parse(content) as T;
        } catch (error) {
            // Retry once on parse error (file might be mid-write)
            await this.sleep(50);
            try {
                const content = fs.readFileSync(this.targetPath, 'utf-8');
                return JSON.parse(content) as T;
            } catch {
                return null;
            }
        }
    }

    async writeJson<T>(data: T): Promise<void> {
        await this.withLock(async () => {
            const tempPath = this.targetPath + '.tmp.' + process.pid + '.' + Date.now();

            try {
                // Ensure directory exists
                const dir = path.dirname(this.targetPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                // Write to temp file
                fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));

                // Atomic rename
                fs.renameSync(tempPath, this.targetPath);
            } finally {
                // Clean up temp file if it still exists
                try {
                    if (fs.existsSync(tempPath)) {
                        fs.unlinkSync(tempPath);
                    }
                } catch {
                    // Ignore cleanup errors
                }
            }
        });
    }

    async modifyJson<T>(modifier: (data: T | null) => T | null): Promise<void> {
        await this.withLock(async () => {
            const current = await this.readJsonUnsafe<T>();
            const modified = modifier(current);

            if (modified === null) {
                // Delete the file if modifier returns null
                try {
                    if (fs.existsSync(this.targetPath)) {
                        fs.unlinkSync(this.targetPath);
                    }
                } catch {
                    // Ignore
                }
                return;
            }

            const tempPath = this.targetPath + '.tmp.' + process.pid + '.' + Date.now();

            try {
                // Ensure directory exists
                const dir = path.dirname(this.targetPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                // Write to temp file
                fs.writeFileSync(tempPath, JSON.stringify(modified, null, 2));

                // Atomic rename
                fs.renameSync(tempPath, this.targetPath);
            } finally {
                // Clean up temp file if it still exists
                try {
                    if (fs.existsSync(tempPath)) {
                        fs.unlinkSync(tempPath);
                    }
                } catch {
                    // Ignore cleanup errors
                }
            }
        });
    }

    private async readJsonUnsafe<T>(): Promise<T | null> {
        try {
            if (!fs.existsSync(this.targetPath)) {
                return null;
            }
            const content = fs.readFileSync(this.targetPath, 'utf-8');
            return JSON.parse(content) as T;
        } catch {
            return null;
        }
    }

    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquireLock();
        try {
            return await fn();
        } finally {
            this.releaseLock();
        }
    }

    private async acquireLock(): Promise<void> {
        const maxAttempts = 50;
        const retryDelay = 100;

        for (let i = 0; i < maxAttempts; i++) {
            // Check for stale lock
            if (fs.existsSync(this.lockPath)) {
                try {
                    const stat = fs.statSync(this.lockPath);
                    const age = Date.now() - stat.mtimeMs;
                    if (age > this.lockTimeout) {
                        // Lock is stale, break it
                        fs.unlinkSync(this.lockPath);
                    }
                } catch {
                    // Lock file may have been deleted by another process
                }
            }

            // Try to acquire lock
            try {
                fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
                return;
            } catch (error: unknown) {
                const err = error as NodeJS.ErrnoException;
                if (err.code !== 'EEXIST') {
                    throw error;
                }
                // Lock exists, wait and retry
                await this.sleep(retryDelay);
            }
        }

        // If we couldn't get the lock after all attempts, force acquire
        // This is a fallback to prevent deadlocks
        try {
            fs.writeFileSync(this.lockPath, String(process.pid));
        } catch {
            // Proceed anyway
        }
    }

    private releaseLock(): void {
        try {
            if (fs.existsSync(this.lockPath)) {
                fs.unlinkSync(this.lockPath);
            }
        } catch {
            // Ignore errors releasing lock
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
