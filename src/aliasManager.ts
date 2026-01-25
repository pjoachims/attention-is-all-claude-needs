import { promises as fsPromises } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Debug logging - set to true for verbose console output
const DEBUG = false;

/**
 * Manages session aliases (user-defined names for sessions)
 * Aliases are keyed by session ID for unique identification
 */
export class AliasManager {
    private aliases: Map<string, string> = new Map();
    private readonly aliasesFilePath: string;

    constructor() {
        this.aliasesFilePath = path.join(
            os.homedir(),
            '.claude',
            'attention-monitor',
            'aliases.json'
        );
    }

    async load(): Promise<void> {
        try {
            const content = await fsPromises.readFile(this.aliasesFilePath, 'utf-8');
            const data = JSON.parse(content) as Record<string, string>;
            this.aliases = new Map(Object.entries(data));
        } catch (error) {
            // File doesn't exist or parse error - start with empty aliases
            if (DEBUG) {
                console.error('Failed to load aliases:', error);
            }
        }
    }

    async save(): Promise<void> {
        try {
            const dir = path.dirname(this.aliasesFilePath);
            await fsPromises.mkdir(dir, { recursive: true });
            const data = Object.fromEntries(this.aliases);
            await fsPromises.writeFile(this.aliasesFilePath, JSON.stringify(data, null, 2));
        } catch (error) {
            if (DEBUG) {
                console.error('Failed to save aliases:', error);
            }
        }
    }

    get(cwd: string): string | undefined {
        return this.aliases.get(cwd);
    }

    set(cwd: string, alias: string): void {
        this.aliases.set(cwd, alias);
    }

    delete(cwd: string): boolean {
        return this.aliases.delete(cwd);
    }

    has(cwd: string): boolean {
        return this.aliases.has(cwd);
    }

    getCount(): number {
        return this.aliases.size;
    }

    getFilePath(): string {
        return this.aliasesFilePath;
    }
}

// Singleton instance for shared access
export const aliasManager = new AliasManager();
