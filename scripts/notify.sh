#!/bin/bash
# Claude Code Attention Monitor - Fast Hook Script
# Uses one file per session to avoid JSON parsing overhead

# Only track sessions from VS Code integrated terminal
[[ "$TERM_PROGRAM" != "vscode" ]] && exit 0

ACTION="$1"
REASON="${2:-permission_prompt}"
CWD="${CLAUDE_WORKING_DIRECTORY:-$(pwd)}"
SESSION_ID="${CLAUDE_SESSION_ID:-ppid-$PPID}"
SESSIONS_DIR=~/.claude/claude-attn/sessions
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$SESSIONS_DIR"

SESSION_FILE="$SESSIONS_DIR/$SESSION_ID.json"

case "$ACTION" in
    attention)
        printf '{"id":"%s","status":"attention","reason":"%s","cwd":"%s","lastUpdate":"%s"}' \
            "$SESSION_ID" "$REASON" "$CWD" "$TIMESTAMP" > "$SESSION_FILE"
        ;;
    start)
        printf '{"id":"%s","status":"running","cwd":"%s","lastUpdate":"%s"}' \
            "$SESSION_ID" "$CWD" "$TIMESTAMP" > "$SESSION_FILE"
        ;;
    end)
        rm -f "$SESSION_FILE"
        ;;
    idle)
        printf '{"id":"%s","status":"idle","cwd":"%s","lastUpdate":"%s"}' \
            "$SESSION_ID" "$CWD" "$TIMESTAMP" > "$SESSION_FILE"
        ;;
esac
