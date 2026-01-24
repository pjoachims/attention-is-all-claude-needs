/**
 * Test setup file - registers mock VS Code module.
 * This file is required before running unit tests outside of VS Code.
 */

import * as Module from 'module';
import * as path from 'path';

// Get the mock vscode module
const mockVscodePath = path.join(__dirname, 'vscode');

// Override module resolution to use our mock for 'vscode'
const originalRequire = Module.prototype.require;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module.prototype as any).require = function(id: string) {
    if (id === 'vscode') {
        return originalRequire.call(this, mockVscodePath);
    }
    return originalRequire.call(this, id);
};

// Set NODE_ENV for tests
process.env.NODE_ENV = 'test';
