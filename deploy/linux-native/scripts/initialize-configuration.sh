#!/usr/bin/env bash
set -euo pipefail
ROOT=/opt/tdai-memory
SETTINGS=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --settings) SETTINGS="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$ROOT/config"
if [[ -z "$SETTINGS" ]]; then
  if [[ -f "$ROOT/config/settings.env" ]]; then
    SETTINGS="$ROOT/config/settings.env"
  else
    SETTINGS="$SCRIPT_DIR/../config/settings.example.env"
  fi
fi
if [[ ! -f "$SETTINGS" ]]; then
  echo "Settings file not found: $SETTINGS" >&2
  exit 1
fi
if [[ "$SETTINGS" != "$ROOT/config/settings.env" ]]; then
  cp "$SETTINGS" "$ROOT/config/settings.env"
fi
chmod 600 "$ROOT/config/settings.env"
set -a
# shellcheck disable=SC1090
source "$ROOT/config/settings.env"
set +a
"$ROOT/runtime/node/bin/node" "$ROOT/scripts/generate-config.mjs" "$ROOT"
chmod 600 "$ROOT/config"/*.key "$ROOT/config"/*.env
