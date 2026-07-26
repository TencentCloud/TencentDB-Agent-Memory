#!/usr/bin/env bash
# Codex Stop hook: capture the last user/assistant turn from the transcript and
# send it to the TdaiGateway for memory storage (fire-and-forget).
# Receives the hook payload as JSON on stdin.
set -uo pipefail

GATEWAY="${TDAI_GATEWAY_URL:-http://127.0.0.1:8420}"

payload=$(cat)
session_id=$(echo "$payload" | jq -r '.session_id // empty')
transcript_path=$(echo "$payload" | jq -r '.transcript_path // empty')

user_text=""
assistant_text=""
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  user_text=$(tail -20 "$transcript_path" | jq -r 'select(.role=="user") | .content' 2>/dev/null | tail -1)
  assistant_text=$(tail -20 "$transcript_path" | jq -r 'select(.role=="assistant") | .content' 2>/dev/null | tail -1)
fi

# Skip if there's nothing meaningful to capture.
[ -z "$user_text" ] && [ -z "$assistant_text" ] && exit 0

# Gateway /capture expects { user_content, assistant_content, session_key }.
curl -s --max-time 25 -X POST "$GATEWAY/capture" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg u "$user_text" --arg a "$assistant_text" --arg s "$session_id" \
        '{user_content: $u, assistant_content: $a, session_key: $s}')" &

exit 0
