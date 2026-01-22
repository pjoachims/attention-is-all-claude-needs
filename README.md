# Attention Is All Claude Needs

A VS Code extension that monitors [Claude Code](https://claude.ai/code) sessions and shows which ones need your attention. Jump to any session instantly - even across VS Code windows.

> *"Attention Is All You Need"* - but for Claude Code sessions

## Features

- **Status Bar Overview**: See at a glance how many sessions need attention, are running, or idle
- **Quick Session Picker**: Click the robot icon to see all sessions grouped by status
- **Cross-Window Focus**: In global mode, click a session and automatically switch to the correct VS Code window
- **Auto Terminal Focus**: Finds the right terminal using PID matching - no manual linking needed
- **Auto-Clear Attention**: When you focus a session, the attention status clears automatically
- **Multi-Root Workspace Support**: Works with git worktrees and multi-folder workspaces

## Status Bar

```
$(hubot) $(bell-dot) 2 $(clock) 1 $(play) 3
   │         │           │          └── 3 running
   │         │           └── 1 idle
   │         └── 2 need attention (highlighted)
   └── Click for session picker
```

## Installation

### From GitHub Release

1. Download the latest `.vsix` from [Releases](https://github.com/pjoachims/attention-is-all-claude-needs/releases)
2. Install with:
   ```bash
   code --install-extension attention-is-all-claude-needs-0.1.0.vsix
   ```

### From Source

```bash
git clone https://github.com/pjoachims/attention-is-all-claude-needs
cd attention-is-all-claude-needs
npm install
npm run compile
npm run package
code --install-extension attention-is-all-claude-needs-0.1.0.vsix
```

### First Run

On first activation, the extension will ask to set up Claude Code hooks. Click "Setup Hooks" to automatically configure:
- `~/.claude/settings.json` - adds notification hooks
- `~/.claude/attention-monitor/notify.sh` - hook script

Restart any running Claude Code sessions for hooks to take effect.

## Usage

### Session Picker (Robot Icon)

Click the `$(hubot)` icon in the status bar to:
- See all sessions grouped by status (Attention → Running → Idle)
- Click any session to focus its terminal
- Toggle between Global/Workspace mode
- Cleanup stale sessions

### Global vs Workspace Mode

- **Workspace Mode** (default): Only shows sessions from the current workspace
- **Global Mode**: Shows all sessions across all VS Code windows. Clicking a session from another window will switch to that window and focus the terminal.

Toggle via the session picker or settings: `claudeMonitor.globalMode`

### Status Bar Buttons

Each status indicator is clickable:
- `$(bell-dot) N` - Click to focus attention-needed sessions
- `$(clock) N` - Click to focus idle sessions
- `$(play) N` - Click to focus running sessions

If there's only one session in a category, it focuses directly. Otherwise, shows a picker.

## How It Works

1. **Claude Code Hooks**: When Claude needs attention (permission prompt, idle, etc.), a hook writes to `~/.claude/attention-monitor/sessions.json`

2. **File Watching**: The extension watches this file and updates the UI in real-time

3. **PID Matching**: Sessions include the Claude process PID. The extension walks up the process tree to find which terminal owns that process.

4. **Cross-Window IPC**: When focusing a session in another window, the extension writes a focus request to a shared file. The target window's extension sees this and focuses the terminal.

## Platform Support

| Platform | Status |
|----------|--------|
| macOS | ✅ Tested |
| Linux | ⚠️ Untested (should work) |
| Windows | ⚠️ Untested (should work) |
| WSL | ⚠️ Untested (use VS Code in Remote-WSL mode) |

> **Note:** Currently only tested on macOS. Linux and Windows support is implemented but not yet verified. Please report issues!

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeMonitor.globalMode` | `false` | Show sessions from all windows |
| `claudeMonitor.cleanupInterval` | `30` | Seconds between dead session cleanup |

## Commands

- `Claude ATTN: Setup Hooks` - Configure Claude Code hooks
- `Claude ATTN: Cleanup Stale Sessions` - Remove dead sessions
- `Refresh Sessions` - Manually refresh session list

## Requirements

- VS Code 1.85.0+
- Claude Code CLI installed
- Node.js (for hook script)

## License

MIT

## Contributing

Issues and PRs welcome at [GitHub](https://github.com/pjoachims/attention-is-all-claude-needs).

---

*Built with Claude Code, naturally.*
