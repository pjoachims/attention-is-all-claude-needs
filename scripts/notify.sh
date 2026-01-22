#!/bin/bash
# Claude Code Attention Monitor - Hook Script
# This script is called by Claude Code hooks to update session state

# Only track sessions from VS Code integrated terminal
if [ "$TERM_PROGRAM" != "vscode" ]; then
    exit 0
fi

ACTION="$1"
CWD="${CLAUDE_WORKING_DIRECTORY:-$(pwd)}"
# Use PPID (parent process ID) as unique session identifier since CLAUDE_SESSION_ID isn't available
SESSION_ID="${CLAUDE_SESSION_ID:-ppid-$PPID}"
SESSIONS_FILE=~/.claude/attention-monitor/sessions.json
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Ensure directory exists
mkdir -p "$(dirname "$SESSIONS_FILE")"

# Initialize file if it doesn't exist
if [ ! -f "$SESSIONS_FILE" ]; then
    echo '{"sessions":{}}' > "$SESSIONS_FILE"
fi

# Function to update session using Node.js for reliable JSON manipulation
update_session() {
    local status="$1"
    local reason="$2"

    node -e "
        const fs = require('fs');
        const path = '$SESSIONS_FILE';
        let data = { sessions: {} };
        try {
            data = JSON.parse(fs.readFileSync(path, 'utf-8'));
        } catch (e) {}

        if ('$status' === 'ended') {
            delete data.sessions['$SESSION_ID'];
        } else {
            data.sessions['$SESSION_ID'] = {
                id: '$SESSION_ID',
                status: '$status',
                reason: '$reason' || undefined,
                cwd: '$CWD',
                lastUpdate: '$TIMESTAMP'
            };
        }

        fs.writeFileSync(path, JSON.stringify(data, null, 2));
    " 2>/dev/null || {
        # Fallback: simple file write (less reliable for concurrent access)
        echo '{"sessions":{"'$SESSION_ID'":{"id":"'$SESSION_ID'","status":"'$status'","cwd":"'$CWD'","lastUpdate":"'$TIMESTAMP'"}}}' > "$SESSIONS_FILE"
    }
}

case "$ACTION" in
    attention)
        update_session "attention" "${2:-permission_prompt}"
        ;;
    start)
        update_session "running" ""
        ;;
    end)
        update_session "ended" ""
        ;;
    idle)
        update_session "idle" ""
        ;;
    *)
        echo "Unknown action: $ACTION" >&2
        exit 1
        ;;
esac
