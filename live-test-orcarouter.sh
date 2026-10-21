#!/usr/bin/env bash
# L3 live test: verify OrcaRouter works as an OpenAI-compatible upstream for
# TencentDB-Agent-Memory's proxy forward path.
# The proxy forwards OpenAI /v1/chat/completions verbatim to upstream.url.
# This exercises the exact wire shape the proxy sends.
set -uo pipefail

API_KEY="${ORCAROUTER_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "FAIL: ORCAROUTER_API_KEY not set"
  exit 1
fi

echo "== 1) GET /v1/models (connectivity + key) =="
code=$(curl -s -m 30 -o /tmp/orca_models.json -w "%{http_code}" \
  https://api.orcarouter.ai/v1/models \
  -H "Authorization: Bearer $API_KEY")
echo "HTTP $code"
if [ "$code" != "200" ]; then
  echo "FAIL: /v1/models returned $code"; cat /tmp/orca_models.json | head -c 400; echo; exit 1
fi
echo "OK: /v1/models works"

echo
echo "== 2) POST /v1/chat/completions (proxy forward path) =="
code=$(curl -s -m 60 -o /tmp/orca_chat.json -w "%{http_code}" \
  -X POST https://api.orcarouter.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"orcarouter/free","messages":[{"role":"user","content":"ping"}],"max_tokens":8,"stream":false}')
echo "HTTP $code"
if [ "$code" != "200" ]; then
  echo "FAIL: chat/completions returned $code"; cat /tmp/orca_chat.json | head -c 400; echo; exit 1
fi
obj=$(python3 -c 'import json,sys; d=json.load(open("/tmp/orca_chat.json")); print(d.get("object",""), d.get("model",""))' 2>/dev/null)
echo "OK: chat.completion object=${obj% *} model=${obj#* }"

echo
echo "LIVE TEST PASSED: OrcaRouter is reachable and answers the OpenAI-compatible "
echo "chat/completions call that MemoryProxy forwards to upstream.url."
