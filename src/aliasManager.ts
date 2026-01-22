import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Manages session aliases (user-defined names for sessions)
 * Aliases are keyed by cwd to persist across session restarts
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
            if (fs.existsSync(this.aliasesFilePath)) {
                const content = fs.readFileSync(this.aliasesFilePath, 'utf-8');
                const data = JSON.parse(content) as Record<string, string>;
                this.aliases = new Map(Object.entries(data));
            }
        } catch (error) {
            console.error('Failed to load aliases:', error);
        }
    }

    async save(): Promise<void> {
        try {
            const dir = path.dirname(this.aliasesFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const data = Object.fromEntries(this.aliases);
            fs.writeFileSync(this.aliasesFilePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Failed to save aliases:', error);
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
}

// Singleton instance for shared access
export const aliasManager = new AliasManager();
