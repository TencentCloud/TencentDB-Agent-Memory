#!/usr/bin/env bash
# Codex UserPromptSubmit hook: recall relevant memories from the TdaiGateway
# and return them as additionalContext for Codex to inject.
# Receives the hook payload as JSON on stdin. Fails silently (no output) on error.
set -uo pipefail

GATEWAY="${TDAI_GATEWAY_URL:-http://127.0.0.1:8420}"

payload=$(cat)
prompt=$(echo "$payload" | jq -r '.prompt // empty')
session_id=$(echo "$payload" | jq -r '.session_id // empty')
cwd=$(echo "$payload" | jq -r '.cwd // empty')

# Nothing to recall without a prompt; exit cleanly with no output.
[ -z "$prompt" ] && exit 0

# Gateway /recall expects { query, session_key } (snake_case per gateway types.ts).
response=$(curl -s --max-time 12 -X POST "$GATEWAY/recall" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$prompt" --arg s "$session_id" \
        '{query: $q, session_key: $s}')")

context=$(echo "$response" | jq -r '.context // empty')

if [ -n "$context" ]; then
  jq -n --arg ctx "$context" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: $ctx
    }
  }'
fi
