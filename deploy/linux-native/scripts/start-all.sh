#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENTS=(core knowledge panel proxy)
if [[ -f /etc/systemd/system/tdai-memory-core.service ]] && grep -Fq "WorkingDirectory=$ROOT" /etc/systemd/system/tdai-memory-core.service; then
  systemctl start tdai-memory.target
  exec "$ROOT/scripts/verify.sh"
fi
cleanup_on_failure() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    "$ROOT/scripts/stop-all.sh" || true
  fi
}
trap cleanup_on_failure EXIT
for component in "${COMPONENTS[@]}"; do
  if [[ ! -f "$ROOT/config/$component.env" ]]; then
    echo "Configuration is missing. Run $ROOT/scripts/install.sh first." >&2
    exit 1
  fi
done
mkdir -p "$ROOT/run" "$ROOT/logs"
start_component() {
  local component="$1"
  local pid_file="$ROOT/run/$component.pid"
  if [[ -f "$pid_file" ]]; then
    local old_pid
    old_pid="$(<"$pid_file")"
    if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "$component is already running (PID $old_pid)"
      return
    fi
    rm -f "$pid_file"
  fi
  nohup "$ROOT/scripts/run-component.sh" "$component" \
    >>"$ROOT/logs/$component.out.log" 2>>"$ROOT/logs/$component.err.log" &
  echo "$!" >"$pid_file"
  echo "Started $component (PID $!)"
  "$ROOT/scripts/wait-health.sh" "$component"
  if [[ "$component" == "core" ]]; then
    "$ROOT/scripts/initialize-admin.sh"
  fi
}
for component in "${COMPONENTS[@]}"; do
  start_component "$component"
done
"$ROOT/scripts/verify.sh"
trap - EXIT
