#!/usr/bin/env bash
# Regression coverage for deploy/global-images/start-memory-hub.sh host IP probes.

set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HUB_SH="$SCRIPT_DIR/../deploy/global-images/start-memory-hub.sh"
FUNCTIONS_FILE="$(mktemp -t detect-host-ip.XXXXXX)"
trap 'rm -f "$FUNCTIONS_FILE"' EXIT

# Source only the side-effect-free helpers under test. Sourcing the complete
# deployment script would load .env and start containers.
awk '
  /^is_usable_ipv4\(\)/ { capture=1 }
  capture && /^if \[\[ -z .*MEMORY_HUB_PROXY_PUBLIC_URL/ { exit }
  capture { print }
' "$HUB_SH" > "$FUNCTIONS_FILE"

if [[ ! -s "$FUNCTIONS_FILE" ]]; then
  echo "FAIL: could not extract host IP helpers from $HUB_SH" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$FUNCTIONS_FILE"

detect_with() (
  local os="$1" hostname_output="$2" ipconfig_output="$3" route_output="$4"

  # All probes are intentionally available. Their output controls which branch
  # succeeds, while the OS value decides whether ipconfig may be consulted.
  # shellcheck disable=SC2329  # Invoked indirectly by detect_host_ip.
  command() { [[ "${1:-}" == "-v" ]]; }
  # shellcheck disable=SC2329
  uname() { printf '%s\n' "$os"; }
  # shellcheck disable=SC2329
  hostname() { printf '%s' "$hostname_output"; }
  # shellcheck disable=SC2329
  ipconfig() { printf '%s' "$ipconfig_output"; }
  # shellcheck disable=SC2329
  ip() { printf '%s' "$route_output"; }

  detect_host_ip
)

failures=0
assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf 'PASS: %s\n' "$label"
  else
    printf 'FAIL: %s\n  expected: %q\n  actual:   %q\n' \
      "$label" "$expected" "$actual" >&2
    failures=$((failures + 1))
  fi
}

assert_eq "Linux selects a usable hostname address" "10.0.0.5" \
  "$(detect_with Linux $'127.0.0.1 10.0.0.5\n' '' '')"

assert_eq "macOS accepts ipconfig getifaddr output" "192.168.1.10" \
  "$(detect_with Darwin '' $'192.168.1.10\n' '')"

assert_eq "Windows skips the macOS ipconfig probe" "localhost" \
  "$(detect_with MINGW64_NT-10.0 '' $'Windows IP Configuration\n\nIPv4 Address: 192.168.1.100\n' '')"

assert_eq "Windows ignores even valid-looking ipconfig output" "localhost" \
  "$(detect_with MINGW64_NT-10.0 '' $'192.168.1.100\n' '')"

assert_eq "Linux accepts a valid ip route source" "10.0.0.7" \
  "$(detect_with Linux '' '' $'1.0.0.0 via 10.0.0.1 dev eth0 src 10.0.0.7 uid 1000\n')"

assert_eq "Link-local hostname output falls through to ip route" "10.0.0.8" \
  "$(detect_with Linux $'169.254.1.9\n' '' $'1.0.0.0 dev eth0 src 10.0.0.8\n')"

assert_eq "Malformed ip route output falls back safely" "localhost" \
  "$(detect_with Linux '' '' $'1.0.0.0 dev eth0 src not-an-ip\n')"

assert_eq "ip route output without src falls back safely" "localhost" \
  "$(detect_with Linux '' '' $'1.0.0.0 dev eth0\n')"

assert_eq "Out-of-range IPv4 output is rejected" "localhost" \
  "$(detect_with Darwin '' $'999.1.1.1\n' '')"

if ((failures > 0)); then
  printf '\n%d regression test(s) failed\n' "$failures" >&2
  exit 1
fi

printf '\nAll host IP detection regression tests passed\n'
