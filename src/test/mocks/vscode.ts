/**
 * Mock VS Code API for unit testing outside of VS Code.
 * Provides minimal implementations of commonly used VS Code interfaces.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

export class MockEventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];

    get event() {
        return (listener: (e: T) => void) => {
            this.listeners.push(listener);
            return { dispose: () => this.removeListener(listener) };
        };
    }

    fire(data: T): void {
        this.listeners.forEach(l => l(data));
    }

    private removeListener(listener: (e: T) => void): void {
        const index = this.listeners.indexOf(listener);
        if (index !== -1) {
            this.listeners.splice(index, 1);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

export class MockDisposable {
    dispose(): void {}
}

export class MockStatusBarItem {
    text: string = '';
    tooltip: string | undefined;
    command: string | undefined;
    backgroundColor: { id: string } | undefined;

    show(): void {}
    hide(): void {}
    dispose(): void {}
}

export class MockOutputChannel {
    name: string;
    private lines: string[] = [];

    constructor(name: string) {
        this.name = name;
    }

    appendLine(value: string): void {
        this.lines.push(value);
    }

    append(value: string): void {
        if (this.lines.length === 0) {
            this.lines.push(value);
        } else {
            this.lines[this.lines.length - 1] += value;
        }
    }

    clear(): void {
        this.lines = [];
    }

    show(): void {}
    hide(): void {}
    dispose(): void {}

    getLines(): string[] {
        return [...this.lines];
    }
}

export class MockTerminal {
    name: string;
    processId: Promise<number | undefined>;

    constructor(name: string, pid?: number) {
        this.name = name;
        this.processId = Promise.resolve(pid);
    }

    show(preserveFocus?: boolean): void {}
    dispose(): void {}
}

export class MockTreeItem {
    label: string;
    collapsibleState: number;
    contextValue?: string;
    description?: string;
    command?: { command: string; title: string; arguments?: unknown[] };

    constructor(label: string, collapsibleState: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}

export const TreeItemCollapsibleState = {
    None: 0,
    Collapsed: 1,
    Expanded: 2
};

export const StatusBarAlignment = {
    Left: 1,
    Right: 2
};

export const QuickPickItemKind = {
    Separator: -1,
    Default: 0
};

export class ThemeColor {
    id: string;
    constructor(id: string) {
        this.id = id;
    }
}

export class ThemeIcon {
    id: string;
    color?: ThemeColor;
    constructor(id: string, color?: ThemeColor) {
        this.id = id;
        this.color = color;
    }
}

export class MarkdownString {
    value: string = '';

    appendMarkdown(value: string): this {
        this.value += value;
        return this;
    }

    appendText(value: string): this {
        this.value += value;
        return this;
    }
}

export const ConfigurationTarget = {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
};

// Mock window namespace
export const window = {
    createOutputChannel: (name: string) => new MockOutputChannel(name),
    createStatusBarItem: (_alignment?: number, _priority?: number) => new MockStatusBarItem(),
    showInformationMessage: async (_message: string, ..._items: string[]) => undefined,
    showWarningMessage: async (_message: string, ..._options: unknown[]) => undefined,
    showErrorMessage: async (_message: string, ..._items: string[]) => undefined,
    showQuickPick: async (_items: unknown[], _options?: unknown) => undefined,
    showInputBox: async (_options?: unknown) => undefined,
    createTreeView: (_viewId: string, _options: unknown) => ({
        dispose: () => {}
    }),
    terminals: [] as MockTerminal[],
    onDidOpenTerminal: new MockEventEmitter<MockTerminal>().event,
    onDidCloseTerminal: new MockEventEmitter<MockTerminal>().event
};

// Mock workspace namespace
export const workspace = {
    workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
    getConfiguration: (_section?: string) => ({
        get: <T>(_key: string, defaultValue?: T) => defaultValue,
        update: async (_key: string, _value: unknown, _target?: unknown) => {}
    }),
    onDidChangeWorkspaceFolders: new MockEventEmitter<unknown>().event
};

// Mock commands namespace
export const commands = {
    registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown) => new MockDisposable(),
    executeCommand: async (_command: string, ..._args: unknown[]) => undefined
};

// Mock Uri
export const Uri = {
    file: (path: string) => ({ fsPath: path, scheme: 'file' }),
    parse: (value: string) => ({ fsPath: value, scheme: 'file' })
};

// Re-export for EventEmitter
export const EventEmitter = MockEventEmitter;
export const Disposable = MockDisposable;
export const TreeItem = MockTreeItem;
