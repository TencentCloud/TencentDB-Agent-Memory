#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENT="${1:-}"
if [[ ! "$COMPONENT" =~ ^(core|knowledge|panel|proxy)$ ]]; then
  echo "Usage: run-component.sh {core|knowledge|panel|proxy}" >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$ROOT/config/$COMPONENT.env"
set +a
NODE="$ROOT/runtime/node/bin/node"
case "$COMPONENT" in
  core)
    cd "$ROOT/app/MemoryCore"
    exec "$NODE" --import tsx src/gateway/server.ts
    ;;
  knowledge)
    cd "$ROOT/app/MemoryKnowledge"
    ENTRY="$ROOT/app/MemoryKnowledge/dist/server.js"
    [[ -f "$ENTRY" ]] || ENTRY="$ROOT/app/MemoryKnowledge/dist/server.mjs"
    exec "$NODE" "$ENTRY"
    ;;
  panel)
    cd "$ROOT/app/MemoryPanel"
    exec "$NODE" dist/index.js
    ;;
  proxy)
    cd "$ROOT/app/MemoryProxy"
    exec "$NODE" --import tsx/esm src/index.ts --config "$ROOT/config/proxy.yaml"
    ;;
esac
