#!/usr/bin/env bash
#
# Claude Code "SessionStart" hook — inject a compact L3 profile + scene index
# into the session context, for subscription-authenticated (OAuth) users who
# cannot route through ANTHROPIC_BASE_URL.
#
# Reads from the Gateway's /v2/core/read (L3 persona) and /v2/scenario/ls
# (L2 scene index) and prints a small labelled block to stdout, which Claude
# Code adds to the session context.
#
# Env:
#   TD_MEMORY_URL   Gateway base URL        (default http://127.0.0.1:8420)
#   TD_MEMORY_KEY   Business user key       (required; without it, no output)
#   TD_MEMORY_TEAM_ID / TD_MEMORY_AGENT_ID / TD_MEMORY_USER_ID  (optional)
#
set +e

export TD_MEMORY_URL="${TD_MEMORY_URL:-http://127.0.0.1:8420}"
export TD_MEMORY_KEY="${TD_MEMORY_KEY:-}"

[[ -n "$TD_MEMORY_KEY" ]] || exit 0

core_json="$(
  curl -sS --max-time 4 \
    -X POST "${TD_MEMORY_URL%/}/v2/core/read" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TD_MEMORY_KEY}" \
    -d '{}' 2>/dev/null || true
)"
scenes_json="$(
  curl -sS --max-time 4 \
    -X POST "${TD_MEMORY_URL%/}/v2/scenario/ls" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TD_MEMORY_KEY}" \
    -d '{}' 2>/dev/null || true
)"

python3 - "$core_json" "$scenes_json" <<'PY'
import json, sys

lines = []

core_raw, scenes_raw = sys.argv[1], sys.argv[2]

try:
    core = json.loads(core_raw)
    content = (core.get("data") or {}).get("content")
    if content:
        lines.append("<user-profile>")
        lines.append(content.strip())
        lines.append("</user-profile>")
except Exception:
    pass

try:
    scenes = json.loads(scenes_raw)
    entries = (scenes.get("data") or {}).get("entries") or []
    paths = [e.get("path") for e in entries if isinstance(e, dict) and e.get("path")]
    if paths:
        lines.append("<known-scenes>")
        lines.extend(f"- {p}" for p in paths)
        lines.append("</known-scenes>")
except Exception:
    pass

if lines:
    print("\n".join(lines))
PY

exit 0
