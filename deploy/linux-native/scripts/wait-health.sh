#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENT="${1:-}"
case "$COMPONENT" in
  core) source "$ROOT/config/core.env"; PORT="$TDAI_GATEWAY_PORT" ;;
  knowledge) source "$ROOT/config/knowledge.env"; PORT="$PORT" ;;
  panel) source "$ROOT/config/panel.env"; PORT="$PORT" ;;
  proxy) PORT="$("$ROOT/runtime/node/bin/node" -p "JSON.parse(require('fs').readFileSync('$ROOT/config/proxy.yaml','utf8')).server.port")" ;;
  *) echo "Usage: wait-health.sh {core|knowledge|panel|proxy}" >&2; exit 2 ;;
esac
for ((i = 0; i < 180; i++)); do
  if curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$PORT/health" >/dev/null; then
    echo "$COMPONENT is healthy on port $PORT"
    exit 0
  fi
  sleep 0.5
done
echo "$COMPONENT did not become healthy within 90 seconds" >&2
exit 1
