# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Attention Is All Claude Needs** - A VS Code extension that monitors Claude Code sessions and displays their status (attention needed, running, idle) in a tree view and status bar. It integrates with Claude Code's hook system to track session lifecycle events. Supports cross-window session switching and automatic terminal focus via PID matching. Works on macOS, Linux, and Windows.

## Build and Development Commands

```bash
npm run compile      # Build TypeScript to JavaScript (output in out/)
npm run watch        # Watch mode for development
npm run lint         # Run ESLint on src/**/*.ts
npm run package      # Create .vsix for distribution
```

To test the extension: Press F5 in VS Code to launch the Extension Development Host.

## Architecture

**Core Modules (src/):**

- **extension.ts** - Main entry point. Handles VS Code activation, command registration, status bar management, and hook setup automation. Contains platform-specific hook scripts (bash for Unix, batch+PowerShell for Windows).

- **sessionManager.ts** - State management. Loads sessions from per-session JSON files in `~/.claude/claude-attn/sessions/`, provides filtering by status/workspace, and emits change events.

- **sessionCleaner.ts** - Periodic cleanup of dead sessions by checking if the Claude process (PID) is still alive. Uses `process.kill(pid, 0)` on Unix, `tasklist` on Windows.

- **directoryWatcher.ts** - Watches the sessions directory for file changes with 50ms debouncing. Triggers session reload on any .json file change.

- **fileWatcher.ts** - Watches a single file for changes (used for cross-window focus requests). 100ms debounce, auto-restarts on errors.

- **terminalTracker.ts** - Singleton that maintains bidirectional mappings between session IDs and VS Code terminals. Used for PID-based terminal matching.

- **aliasManager.ts** - Singleton for user-defined session names (aliases). Persists to `~/.claude/attention-monitor/aliases.json`, keyed by cwd.

- **views/sessionTreeView.ts** - TreeDataProvider for the activity bar view. Groups sessions by status category.

**Data Flow:**
1. Claude Code hook events trigger `notify.sh`/`notify.cmd` script
2. Script writes/updates/deletes `~/.claude/claude-attn/sessions/{session-id}.json`
3. DirectoryWatcher detects change → SessionManager reloads all session files → UI updates

**Cross-Window Communication:**
- Focus requests written to `~/.claude/claude-attn/focus-request.json`
- FileWatcher in each VS Code window watches this file
- Target window (matching workspace folder) handles the request and focuses terminal

**Session ID Format:** `ppid-{PID}` where PID is the Claude Code process ID. Used for:
- Terminal matching (walk up process tree to find terminal PID)
- Dead session cleanup (check if PID is still alive)

**Key Data Structures:**
```typescript
interface Session {
  id: string;                              // "ppid-12345"
  status: 'attention' | 'running' | 'idle';
  reason?: string;                         // e.g., "permission_prompt"
  cwd?: string;                            // Working directory
  lastUpdate: string;                      // ISO 8601
}
```

**External Files Managed:**
- `~/.claude/claude-attn/sessions/*.json` - One file per active session
- `~/.claude/claude-attn/notify.sh` or `notify.cmd` - Hook script (platform-specific)
- `~/.claude/claude-attn/get-claude-pid.ps1` - Windows-only PowerShell helper
- `~/.claude/claude-attn/focus-request.json` - Cross-window IPC
- `~/.claude/attention-monitor/aliases.json` - User-defined session names
- `~/.claude/settings.json` - Claude Code hook configuration

**Hook Events Used:**
- `Notification` (matcher: `permission_prompt|idle_prompt|elicitation_dialog`) → attention
- `SessionStart` → running
- `SessionEnd` → delete session file
- `Stop` → idle
