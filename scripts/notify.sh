#!/bin/bash
# Claude Code Attention Monitor - Hook Script (Unix/macOS)
# Writes session state to ~/.claude/claude-attn/sessions/

[[ "$TERM_PROGRAM" != "vscode" ]] && exit 0

ACTION="$1"
REASON="${2:-permission_prompt}"
CWD="${CLAUDE_WORKING_DIRECTORY:-$(pwd)}"
SESSIONS_DIR=~/.claude/claude-attn/sessions
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Get PIDs: Claude (PPID of this script), Terminal (Claude's parent)
CLAUDE_PID=$PPID
TERMINAL_PID=$(ps -o ppid= -p $CLAUDE_PID 2>/dev/null | tr -d ' ')
SESSION_ID="${CLAUDE_SESSION_ID:-ppid-$CLAUDE_PID}"

# VS Code IPC handle - unique per VS Code window (deprecated, kept for compatibility)
IPC_HANDLE="${VSCODE_GIT_IPC_HANDLE:-}"

# Window ID from Claude ATTN extension (unique per VS Code window)
WINDOW_ID="${CLAUDE_ATTN_WINDOW_ID:-}"

# Build extra fields for JSON
EXTRA_FIELDS=""
[[ -n "$CLAUDE_PID" ]] && EXTRA_FIELDS=",\"claudePid\":$CLAUDE_PID"
[[ -n "$TERMINAL_PID" ]] && EXTRA_FIELDS="$EXTRA_FIELDS,\"terminalPid\":$TERMINAL_PID"
[[ -n "$IPC_HANDLE" ]] && EXTRA_FIELDS="$EXTRA_FIELDS,\"vscodeIpcHandle\":\"$IPC_HANDLE\""
[[ -n "$WINDOW_ID" ]] && EXTRA_FIELDS="$EXTRA_FIELDS,\"windowId\":\"$WINDOW_ID\""

mkdir -p "$SESSIONS_DIR"
SESSION_FILE="$SESSIONS_DIR/$SESSION_ID.json"

case "$ACTION" in
    attention)
        printf '{"id":"%s","status":"attention","reason":"%s","cwd":"%s","lastUpdate":"%s"%s}' \
            "$SESSION_ID" "$REASON" "$CWD" "$TIMESTAMP" "$EXTRA_FIELDS" > "$SESSION_FILE"
        ;;
    start)
        printf '{"id":"%s","status":"running","cwd":"%s","lastUpdate":"%s"%s}' \
            "$SESSION_ID" "$CWD" "$TIMESTAMP" "$EXTRA_FIELDS" > "$SESSION_FILE"
        ;;
    end)
        rm -f "$SESSION_FILE"
        ;;
    idle)
        printf '{"id":"%s","status":"idle","cwd":"%s","lastUpdate":"%s"%s}' \
            "$SESSION_ID" "$CWD" "$TIMESTAMP" "$EXTRA_FIELDS" > "$SESSION_FILE"
        ;;
esac
