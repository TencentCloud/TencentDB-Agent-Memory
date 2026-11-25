#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOVE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --remove) REMOVE=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ $EUID -ne 0 ]]; then
  echo "Firewall configuration requires root privileges." >&2
  exit 1
fi
if [[ -f "$ROOT/config/settings.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT/config/settings.env"
  set +a
fi
CORE_PORT="${CORE_PORT:-8420}"
KNOWLEDGE_PORT="${KNOWLEDGE_PORT:-8424}"
PANEL_PORT="${PANEL_PORT:-8125}"
PROXY_PORT="${PROXY_PORT:-8096}"
CONFIGURE_FIREWALL="${CONFIGURE_FIREWALL:-1}"
for port in "$CORE_PORT" "$KNOWLEDGE_PORT" "$PANEL_PORT" "$PROXY_PORT"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    echo "Invalid TCP port in firewall configuration: $port" >&2
    exit 1
  fi
done
ufw_profile=/etc/ufw/applications.d/tdai-memory
firewalld_service=/etc/firewalld/services/tdai-memory.xml
remove_rules() {
  if command -v ufw >/dev/null 2>&1 && [[ -f "$ufw_profile" ]]; then
    ufw delete allow "TencentDB Agent Memory" >/dev/null 2>&1 || true
    rm -f "$ufw_profile"
  fi
  if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    local zone
    zone="$(firewall-cmd --get-default-zone)"
    firewall-cmd --permanent --zone="$zone" --remove-service=tdai-memory >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null
  fi
  rm -f "$firewalld_service"
}
if [[ $REMOVE -eq 1 ]]; then
  remove_rules
  echo "Tdai Memory firewall rules removed."
  exit 0
fi
case "${CONFIGURE_FIREWALL,,}" in
  0|false|no|off)
    remove_rules
    echo "Automatic firewall configuration is disabled; Tdai Memory rules were removed."
    exit 0
    ;;
esac
remove_rules
if command -v ufw >/dev/null 2>&1 && [[ "$(LC_ALL=C ufw status | head -n 1)" == "Status: active" ]]; then
  cat >"$ufw_profile" <<EOF
[TencentDB Agent Memory]
title=TencentDB Agent Memory
description=Native MemoryCore, MemoryKnowledge, MemoryPanel and MemoryProxy services
ports=$CORE_PORT,$KNOWLEDGE_PORT,$PANEL_PORT,$PROXY_PORT/tcp
EOF
  ufw allow "TencentDB Agent Memory" >/dev/null
  echo "UFW inbound TCP rules configured for $CORE_PORT, $KNOWLEDGE_PORT, $PANEL_PORT, $PROXY_PORT."
elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  zone="$(firewall-cmd --get-default-zone)"
  cat >"$firewalld_service" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<service>
  <short>TencentDB Agent Memory</short>
  <description>Native MemoryCore, MemoryKnowledge, MemoryPanel and MemoryProxy services</description>
  <port protocol="tcp" port="$CORE_PORT"/>
  <port protocol="tcp" port="$KNOWLEDGE_PORT"/>
  <port protocol="tcp" port="$PANEL_PORT"/>
  <port protocol="tcp" port="$PROXY_PORT"/>
</service>
EOF
  firewall-cmd --reload >/dev/null
  firewall-cmd --permanent --zone="$zone" --add-service=tdai-memory >/dev/null
  firewall-cmd --reload >/dev/null
  echo "firewalld service enabled in zone $zone for TCP ports $CORE_PORT, $KNOWLEDGE_PORT, $PANEL_PORT, $PROXY_PORT."
else
  echo "No active UFW or firewalld instance detected; no host firewall rules are required."
fi
