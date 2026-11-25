#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOVE=0
if [[ "${1:-}" == "--remove" ]]; then
  REMOVE=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: install-systemd.sh [--remove]" >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi
UNIT_DIR=/etc/systemd/system
CORE_UNIT="$UNIT_DIR/tdai-memory-core.service"
UNITS=(tdai-memory-core.service tdai-memory-knowledge.service tdai-memory-panel.service tdai-memory-proxy.service tdai-memory.target)
if [[ $REMOVE -eq 1 ]]; then
  if [[ -f "$CORE_UNIT" ]] && grep -Fq "WorkingDirectory=$ROOT" "$CORE_UNIT"; then
    systemctl stop tdai-memory.target 2>/dev/null || true
    systemctl disable tdai-memory.target 2>/dev/null || true
    rm -f "${UNITS[@]/#/$UNIT_DIR/}"
    systemctl daemon-reload
    systemctl reset-failed "${UNITS[@]%.service}" 2>/dev/null || true
    "$ROOT/scripts/configure-firewall.sh" --root "$ROOT" --remove
    echo "systemd units removed for $ROOT"
  fi
  exit 0
fi
if [[ -f "$ROOT/run/core.pid" ]]; then
  "$ROOT/scripts/stop-all.sh"
fi
if ! id tdai-memory >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$ROOT" --shell /usr/sbin/nologin tdai-memory
fi
for directory in config data logs run; do
  mkdir -p "$ROOT/$directory"
  chown -R tdai-memory:tdai-memory "$ROOT/$directory"
done
ESCAPED_ROOT="${ROOT//\\/\\\\}"
ESCAPED_ROOT="${ESCAPED_ROOT//&/\\&}"
ESCAPED_ROOT="${ESCAPED_ROOT//|/\\|}"
for unit in "${UNITS[@]}"; do
  sed "s|@ROOT@|$ESCAPED_ROOT|g" "$ROOT/systemd/$unit" >"$UNIT_DIR/$unit"
done
systemctl daemon-reload
"$ROOT/scripts/configure-firewall.sh" --root "$ROOT"
echo "systemd units installed for $ROOT"
echo "Enable and start with: systemctl enable --now tdai-memory.target"
