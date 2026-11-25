#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS=
SKIP_FIREWALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --settings) SETTINGS="$2"; shift 2 ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
ARGS=(--root "$ROOT")
if [[ -n "$SETTINGS" ]]; then
  ARGS+=(--settings "$SETTINGS")
fi
"$ROOT/scripts/initialize-configuration.sh" "${ARGS[@]}"
if [[ $SKIP_FIREWALL -eq 0 ]]; then
  if [[ $EUID -eq 0 ]]; then
    "$ROOT/scripts/configure-firewall.sh" --root "$ROOT"
  else
    echo "Firewall configuration was not changed. To apply the configured policy, run: sudo $ROOT/scripts/configure-firewall.sh --root $ROOT"
  fi
fi
echo "Installation initialized: $ROOT"
print_panel_summary() {
  local HOST=0.0.0.0
  local PORT=8125
  # shellcheck disable=SC1091
  source "$ROOT/config/panel.env"
  printf 'Local Panel URL: http://127.0.0.1:%s/ (listening on %s:%s)\n' "$PORT" "$HOST" "$PORT"
  # shellcheck disable=SC1091
  source "$ROOT/config/settings.env"
  printf 'Deployment mode: %s\n' "${DEPLOYMENT_MODE:-basic}"
  if [[ -n "${PROXY_UPSTREAM_MODEL:-}" ]]; then
    printf 'Client model: %s\n' "$PROXY_UPSTREAM_MODEL"
  fi
}
print_panel_summary
echo "Start with: $ROOT/scripts/start-all.sh"
