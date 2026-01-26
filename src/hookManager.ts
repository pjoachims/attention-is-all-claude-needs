import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isWindows } from './platform';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const MONITOR_DIR = path.join(CLAUDE_DIR, 'claude-attn');
const SESSIONS_DIR = path.join(MONITOR_DIR, 'sessions');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

/**
 * Manages Claude Code hook setup, deployment, and removal.
 */
export class HookManager {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly extensionPath: string;

    constructor(extensionPath: string, outputChannel: vscode.OutputChannel) {
        this.extensionPath = extensionPath;
        this.outputChannel = outputChannel;
    }

    /**
     * Check if hooks are set up and prompt user if not.
     */
    async checkAndPromptSetup(context: vscode.ExtensionContext): Promise<void> {
        // Always deploy/update scripts on activation (handles extension updates)
        await this.deployScripts();

        const hasSetupHooks = context.globalState.get<boolean>('hasSetupHooks', false);

        if (!hasSetupHooks) {
            const result = await vscode.window.showInformationMessage(
                'Claude Code Attention Monitor needs to configure hooks. Would you like to set them up now?',
                'Setup Hooks',
                'Later',
                "Don't Ask Again"
            );

            if (result === 'Setup Hooks') {
                await this.setupHooks(context);
            } else if (result === "Don't Ask Again") {
                await context.globalState.update('hasSetupHooks', true);
            }
        }
    }

    /**
     * Deploy notification scripts to ~/.claude/claude-attn/.
     * Called on every activation to ensure scripts are up-to-date after extension updates.
     */
    async deployScripts(): Promise<void> {
        const scriptsDir = path.join(this.extensionPath, 'scripts');
        const scriptExt = isWindows ? '.cmd' : '.sh';
        const notifyScriptPath = path.join(MONITOR_DIR, `notify${scriptExt}`);

        try {
            if (!fs.existsSync(SESSIONS_DIR)) {
                fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            }

            // Clean up old/wrong-platform scripts
            const oldScriptExt = isWindows ? '.sh' : '.cmd';
            const oldNotifyScript = path.join(MONITOR_DIR, `notify${oldScriptExt}`);
            if (fs.existsSync(oldNotifyScript)) {
                fs.unlinkSync(oldNotifyScript);
                this.outputChannel.appendLine(`Removed old script: ${oldNotifyScript}`);
            }

            // On non-Windows, remove PowerShell scripts that aren't needed
            if (!isWindows) {
                const psScripts = ['get-pids.ps1', 'get-claude-pid.ps1', 'activate-window.ps1', 'activate-vscode-window.ps1', 'activate-by-pid.ps1'];
                for (const script of psScripts) {
                    const scriptPath = path.join(MONITOR_DIR, script);
                    if (fs.existsSync(scriptPath)) {
                        fs.unlinkSync(scriptPath);
                        this.outputChannel.appendLine(`Removed unneeded script: ${scriptPath}`);
                    }
                }
            }

            // On Windows, remove deprecated PowerShell activation scripts (activate-window.ps1 is still needed)
            if (isWindows) {
                const deprecatedScripts = ['activate-vscode-window.ps1', 'activate-by-pid.ps1'];
                for (const script of deprecatedScripts) {
                    const scriptPath = path.join(MONITOR_DIR, script);
                    if (fs.existsSync(scriptPath)) {
                        fs.unlinkSync(scriptPath);
                        this.outputChannel.appendLine(`Removed deprecated script: ${scriptPath}`);
                    }
                }
            }

            this.deployPlatformScripts(scriptsDir, scriptExt, notifyScriptPath);

            // Clean up old script names (only needed in deployScripts, not setupHooks)
            if (isWindows) {
                const oldPsScript = path.join(MONITOR_DIR, 'get-claude-pid.ps1');
                if (fs.existsSync(oldPsScript)) {
                    fs.unlinkSync(oldPsScript);
                    this.outputChannel.appendLine(`Removed old script: ${oldPsScript}`);
                }
            }

            this.outputChannel.appendLine(`Scripts deployed to ${MONITOR_DIR}`);
        } catch (error) {
            this.outputChannel.appendLine(`Error deploying scripts: ${error}`);
        }
    }

    /**
     * Set up Claude Code hooks by deploying scripts and configuring settings.
     */
    async setupHooks(context: vscode.ExtensionContext): Promise<void> {
        const scriptsDir = path.join(this.extensionPath, 'scripts');
        const scriptExt = isWindows ? '.cmd' : '.sh';
        const notifyScriptPath = path.join(MONITOR_DIR, `notify${scriptExt}`);

        try {
            if (!fs.existsSync(SESSIONS_DIR)) {
                fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            }

            this.deployPlatformScripts(scriptsDir, scriptExt, notifyScriptPath);

            let settings: Record<string, unknown> = {};
            if (fs.existsSync(SETTINGS_PATH)) {
                const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
                settings = JSON.parse(content);
            }

            const hooks = this.getHooksConfig(notifyScriptPath);
            settings['hooks'] = this.mergeHooks(settings['hooks'] as Record<string, unknown> || {}, hooks);

            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

            await context.globalState.update('hasSetupHooks', true);

            vscode.window.showInformationMessage(
                'Claude Code hooks configured successfully! Restart any running Claude Code sessions for changes to take effect.'
            );

            this.outputChannel.appendLine('Hooks setup completed');
            this.outputChannel.appendLine(`Notify script: ${notifyScriptPath}`);
            this.outputChannel.appendLine(`Settings file: ${SETTINGS_PATH}`);
        } catch (error) {
            this.outputChannel.appendLine(`Error setting up hooks: ${error}`);
            vscode.window.showErrorMessage(
                `Failed to setup hooks: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    /**
     * Remove Claude ATTN hooks from Claude Code settings and delete all session data.
     */
    async removeHooks(): Promise<void> {
        // Remove hooks from Claude Code settings
        if (fs.existsSync(SETTINGS_PATH)) {
            const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
            const settings = JSON.parse(content) as Record<string, unknown>;

            if (settings.hooks && typeof settings.hooks === 'object') {
                const hooks = settings.hooks as Record<string, unknown[]>;

                // Filter out any hooks containing 'claude-attn'
                for (const [key, value] of Object.entries(hooks)) {
                    if (Array.isArray(value)) {
                        hooks[key] = value.filter(
                            (h: unknown) => !JSON.stringify(h).includes('claude-attn')
                        );
                        // Remove empty arrays
                        if (hooks[key].length === 0) {
                            delete hooks[key];
                        }
                    }
                }

                // Remove hooks object if empty
                if (Object.keys(hooks).length === 0) {
                    delete settings.hooks;
                }

                fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
            }
        }

        // Delete the claude-attn directory
        if (fs.existsSync(MONITOR_DIR)) {
            fs.rmSync(MONITOR_DIR, { recursive: true, force: true });
        }

        this.outputChannel.appendLine('Hooks removed successfully');
        this.outputChannel.appendLine(`Deleted directory: ${MONITOR_DIR}`);
        this.outputChannel.appendLine(`Updated settings: ${SETTINGS_PATH}`);
    }

    /**
     * Deploy platform-specific scripts (notify script and Windows PowerShell helpers).
     */
    private deployPlatformScripts(scriptsDir: string, scriptExt: string, notifyScriptPath: string): void {
        const bundledNotifyScript = path.join(scriptsDir, `notify${scriptExt}`);
        const notifyScript = fs.readFileSync(bundledNotifyScript, 'utf-8');
        fs.writeFileSync(notifyScriptPath, notifyScript, { mode: isWindows ? 0o644 : 0o755 });

        if (isWindows) {
            // Deploy get-pids.ps1 (still needed for terminal PID matching)
            const bundledGetPids = path.join(scriptsDir, 'get-pids.ps1');
            const getPidsScript = fs.readFileSync(bundledGetPids, 'utf-8');
            fs.writeFileSync(path.join(MONITOR_DIR, 'get-pids.ps1'), getPidsScript);

            // Deploy activate-window.ps1 for robust window switching on Windows
            const bundledActivateWindow = path.join(scriptsDir, 'activate-window.ps1');
            const activateWindowScript = fs.readFileSync(bundledActivateWindow, 'utf-8');
            fs.writeFileSync(path.join(MONITOR_DIR, 'activate-window.ps1'), activateWindowScript);
        }
    }

    /**
     * Generate the hooks configuration for Claude Code settings.
     */
    private getHooksConfig(notifyScriptPath: string): Record<string, unknown> {
        // On Windows, we need cmd.exe /c to run batch files
        const cmdPrefix = isWindows ? 'cmd.exe /c ' : '';

        return {
            Notification: [
                {
                    matcher: 'permission_prompt|idle_prompt|elicitation_dialog',
                    hooks: [
                        {
                            type: 'command',
                            command: `${cmdPrefix}"${notifyScriptPath}" attention`
                        }
                    ]
                }
            ],
            SessionStart: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: `${cmdPrefix}"${notifyScriptPath}" start`
                        }
                    ]
                }
            ],
            SessionEnd: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: `${cmdPrefix}"${notifyScriptPath}" end`
                        }
                    ]
                }
            ],
            Stop: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: `${cmdPrefix}"${notifyScriptPath}" idle`
                        }
                    ]
                }
            ]
        };
    }

    /**
     * Merge new hooks with existing hooks, replacing any claude-attn hooks.
     */
    private mergeHooks(
        existing: Record<string, unknown>,
        newHooks: Record<string, unknown>
    ): Record<string, unknown> {
        const merged = { ...existing };

        for (const [key, value] of Object.entries(newHooks)) {
            if (Array.isArray(merged[key])) {
                const existingHooks = merged[key] as unknown[];
                const newHookArray = value as unknown[];
                const filtered = existingHooks.filter(
                    (h: unknown) => !JSON.stringify(h).includes('claude-attn')
                );
                merged[key] = [...filtered, ...newHookArray];
            } else {
                merged[key] = value;
            }
        }

        return merged;
    }
}
