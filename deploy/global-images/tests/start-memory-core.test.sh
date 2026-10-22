#!/usr/bin/env bash

set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLOBAL_IMAGES_DIR="$(dirname "$TEST_DIR")"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT/bin"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "${1:-}" in' \
  '  network) exit 0 ;;' \
  '  ps) exit 0 ;;' \
  '  run) exit 0 ;;' \
  '  inspect)' \
  '    if [[ "$*" == *State.Status* ]]; then' \
  '      echo running' \
  '    else' \
  '      echo none' \
  '    fi' \
  '    exit 0' \
  '    ;;' \
  'esac' \
  'exit 0' \
  > "$TMP_ROOT/bin/docker"
chmod +x "$TMP_ROOT/bin/docker"

printf '%s\n' \
  'MEMORY_CORE_IMAGE=test/memory-core:latest' \
  'MEMORY_CORE_PORT=1' \
  'MEMORY_CORE_VOLUME=test-memory-core-data' \
  > "$TMP_ROOT/.env"

OUTPUT_FILE="$TMP_ROOT/output.log"

set +e
PATH="$TMP_ROOT/bin:$PATH" \
  ENV_FILE="$TMP_ROOT/.env" \
  MEMORY_CORE_CONFIG_DIR="$TMP_ROOT/config" \
  MEMORY_CORE_ADMIN_KEY_FILE="$TMP_ROOT/admin-key" \
  bash "$GLOBAL_IMAGES_DIR/start-memory-core.sh" > "$OUTPUT_FILE" 2>&1
set -e

if ! grep -F '初始化 admin user' "$OUTPUT_FILE" >/dev/null; then
  cat "$OUTPUT_FILE" >&2
  exit 1
fi

if grep -F 'unbound variable' "$OUTPUT_FILE" >/dev/null; then
  cat "$OUTPUT_FILE" >&2
  exit 1
fi

if ! grep -F 'init-admin 返回 HTTP=' "$OUTPUT_FILE" >/dev/null; then
  cat "$OUTPUT_FILE" >&2
  exit 1
fi

echo "start-memory-core admin initialization logging: ok"
