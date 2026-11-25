#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f /etc/systemd/system/tdai-memory-core.service ]] && grep -Fq "WorkingDirectory=$ROOT" /etc/systemd/system/tdai-memory-core.service; then
  systemctl stop tdai-memory.target
  exit 0
fi
for component in proxy panel knowledge core; do
  pid_file="$ROOT/run/$component.pid"
  [[ -f "$pid_file" ]] || continue
  pid="$(<"$pid_file")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for ((i = 0; i < 100; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid"
    fi
    echo "Stopped $component (PID $pid)"
  fi
  rm -f "$pid_file"
done
