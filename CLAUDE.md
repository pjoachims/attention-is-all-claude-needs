# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Attention Is All Claude Needs** - A VS Code extension that monitors Claude Code sessions and displays their status (attention needed, running, idle) in a tree view and status bar. It integrates with Claude Code's hook system to track session lifecycle events. Supports cross-window session switching and automatic terminal focus via PID matching.

## Build and Development Commands

```bash
npm run compile      # Build TypeScript to JavaScript (output in out/)
npm run watch        # Watch mode for development
npm run lint         # Run ESLint on src/**/*.ts
```

To test the extension: Press F5 in VS Code to launch the Extension Development Host.

## Architecture

**Core Modules (src/):**

- **extension.ts** - Main entry point. Handles VS Code activation, command registration, status bar management, terminal-session associations, and hook setup automation.

- **sessionManager.ts** - State management singleton. Loads sessions from `~/.claude/attention-monitor/sessions.json`, provides filtering by status, and emits change events.

- **fileWatcher.ts** - Monitors the sessions JSON file for external changes with debouncing (100ms). Auto-restarts on errors.

- **views/sessionTreeView.ts** - Implements TreeDataProvider for the activity bar view. Groups sessions by status category with icons and tooltips.

**Data Flow:**
1. Claude Code hook events trigger `notify.sh` script
2. Script updates `~/.claude/attention-monitor/sessions.json`
3. FileWatcher detects change → SessionManager reloads → UI updates

**Key Data Structures:**
```typescript
interface Session {
  id: string;
  status: 'attention' | 'running' | 'idle';
  reason?: string;
  cwd?: string;
  lastUpdate: string;  // ISO 8601
}
```

**External Files Managed:**
- `~/.claude/attention-monitor/sessions.json` - Session state persistence
- `~/.claude/attention-monitor/notify.sh` - Hook script (deployed by extension)
- `~/.claude/settings.json` - Claude Code hook configuration
