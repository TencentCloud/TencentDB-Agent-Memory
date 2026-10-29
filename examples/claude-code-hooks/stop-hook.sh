#!/usr/bin/env bash
#
# Claude Code "Stop" hook — feed the last user/assistant exchange into
# TencentDB Agent Memory for subscription-authenticated (OAuth) users.
#
# Why this exists: the documented integration reroutes ANTHROPIC_BASE_URL
# through memory-proxy, which works for API-key users but breaks
# subscription (OAuth) auth entirely. This hook talks straight to the
# Gateway's /v2/conversation/add API instead, so the conversation still
# flows through the subscription and memory capture still happens.
#
# Behaviour:
#   - Reads the hook JSON (with `transcript`) from stdin
#   - Extracts the last user message and its nearest following assistant reply
#   - POSTs them to {TD_MEMORY_URL}/v2/conversation/add
#   - Fail-silent: never blocks, errors, or slows down Claude Code
#
# Env (all optional except the key for a running Gateway):
#   TD_MEMORY_URL        Gateway base URL          (default http://127.0.0.1:8420)
#   TD_MEMORY_KEY        Business user key (Bearer) (required to write)
#   TD_MEMORY_TEAM_ID    v2 isolation team_id       (optional)
#   TD_MEMORY_AGENT_ID   v2 isolation agent_id      (optional)
#   TD_MEMORY_USER_ID    v2 isolation user_id       (optional)
#   TD_MEMORY_SESSION_ID Force a session_id         (default: from hook or "default")
#
set +e

export TD_MEMORY_URL="${TD_MEMORY_URL:-http://127.0.0.1:8420}"
export TD_MEMORY_KEY="${TD_MEMORY_KEY:-}"
export TD_MEMORY_TEAM_ID="${TD_MEMORY_TEAM_ID:-}"
export TD_MEMORY_AGENT_ID="${TD_MEMORY_AGENT_ID:-}"
export TD_MEMORY_USER_ID="${TD_MEMORY_USER_ID:-}"
export TD_MEMORY_SESSION_ID="${TD_MEMORY_SESSION_ID:-}"

# Without a key there is nothing we can do — stay silent.
[[ -n "$TD_MEMORY_KEY" ]] || exit 0

# Claude Code feeds the hook payload (JSON with `transcript`) via stdin.
input="$(cat 2>/dev/null || true)"
[[ -n "$input" ]] || exit 0

# Build the /v2/conversation/add payload with python3 (present on macOS,
# avoids a jq dependency).
payload="$(
  python3 - "$input" <<'PY'
import json, os, sys

try:
    data = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)

transcript = data.get("transcript") or []
if not isinstance(transcript, list) or len(transcript) == 0:
    sys.exit(0)

# Last user message + its nearest following assistant reply.
user_msg = None
assistant_msg = None
for m in transcript:
    if not isinstance(m, dict):
        continue
    role = m.get("role")
    if role == "user":
        user_msg = m
        assistant_msg = None
    elif role == "assistant" and user_msg is not None:
        assistant_msg = m

if not user_msg:
    sys.exit(0)

session = os.environ.get("TD_MEMORY_SESSION_ID") or data.get("session_id") or "default"
body = {"session_id": session, "messages": []}
for key, env in (("team_id", "TD_MEMORY_TEAM_ID"), ("agent_id", "TD_MEMORY_AGENT_ID"),
                 ("user_id", "TD_MEMORY_USER_ID")):
    val = os.environ.get(env)
    if val:
        body[key] = val

msgs = [user_msg] + ([assistant_msg] if assistant_msg else [])
for m in msgs:
    item = {"role": m.get("role"), "content": m.get("content") or ""}
    if m.get("timestamp"):
        item["timestamp"] = m["timestamp"]
    body["messages"].append(item)

print(json.dumps(body))
PY
)"

[[ -n "$payload" && "$payload" != "null" ]] || exit 0

curl -sS -o /dev/null --max-time 4 \
  -X POST "${TD_MEMORY_URL%/}/v2/conversation/add" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TD_MEMORY_KEY}" \
  -d "$payload" >/dev/null 2>&1 || true

exit 0
