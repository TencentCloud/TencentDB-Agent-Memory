#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PURGE=0
if [[ "${1:-}" == "--purge" ]]; then
  PURGE=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: uninstall.sh [--purge]" >&2
  exit 2
fi
"$ROOT/scripts/stop-all.sh"
if [[ -f /etc/systemd/system/tdai-memory-core.service ]] && grep -Fq "WorkingDirectory=$ROOT" /etc/systemd/system/tdai-memory-core.service; then
  "$ROOT/scripts/install-systemd.sh" --remove
elif [[ $EUID -eq 0 ]]; then
  "$ROOT/scripts/configure-firewall.sh" --root "$ROOT" --remove
fi
if [[ $PURGE -eq 1 ]]; then
  case "$ROOT" in
    /|"") echo "Refusing to remove unsafe root: $ROOT" >&2; exit 1 ;;
  esac
  cd /
  rm -rf "$ROOT"
  echo "Program, configuration, data and logs removed: $ROOT"
else
  echo "Services and processes stopped. Configuration, data and logs are preserved in $ROOT."
fi
