#!/usr/bin/env bash
# Docker-free regression tests for the global-images shell helpers.
#
# Run from any directory:
#   bash deploy/global-images/tests/startup-scripts.test.sh

set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$TEST_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "[test][error] $*" >&2
  exit 1
}

pass() {
  echo "[test][ok] $*"
}

for script in "$ROOT"/*.sh; do
  bash -n "$script" || fail "bash syntax check failed: $script"
done
pass "all deployment scripts pass bash -n"

for script in \
  start-all.sh \
  start-memory-core.sh \
  start-memory-hub.sh \
  start-proxy.sh \
  stop-all.sh \
  verify.sh; do
  if grep -q '/usr/bin/curl' "$ROOT/$script"; then
    fail "$script hard-codes /usr/bin/curl; use the shared \$CURL resolver"
  fi
done
pass "deployment scripts use the shared curl path"

# _lib.sh probes for docker at source time; this only requires the CLI, not a daemon.
# shellcheck source=../_lib.sh
source "$ROOT/_lib.sh"

[[ -n "${CURL:-}" ]] || fail "CURL was not resolved"
if ! command -v "$CURL" >/dev/null 2>&1 && [[ ! -x "$CURL" ]]; then
  fail "resolved curl command is not executable: $CURL"
fi
pass "curl resolver produced an executable command"

declare -F is_valid_http_url >/dev/null || fail "is_valid_http_url is missing"
declare -F port_in_use >/dev/null || fail "port_in_use is missing"
declare -F prompt_secret_with_default >/dev/null || fail "prompt_secret_with_default is missing"
pass "required portability helpers are available"

is_valid_http_url "http://localhost:8096" || fail "localhost URL should be valid"
is_valid_http_url "https://memory.example.com/proxy" || fail "HTTPS base URL should be valid"
if is_valid_http_url "http://"; then
  fail "URL without a host should be rejected"
fi
if is_valid_http_url "ftp://memory.example.com"; then
  fail "non-HTTP URL should be rejected"
fi
if is_valid_http_url "http://local host:8096"; then
  fail "URL containing whitespace should be rejected"
fi
pass "HTTP base URL validation handles valid and invalid inputs"

secret="sk-test-secret"
value="$(
  printf '\n' |
    prompt_secret_with_default "Test API key" "$secret" 2>"$TMP_DIR/prompt.stderr"
)"
[[ "$value" == "$secret" ]] || fail "empty secret input should preserve the existing value"
grep -q "已配置" "$TMP_DIR/prompt.stderr" || fail "secret prompt should show a configured-state hint"
if grep -q "$secret" "$TMP_DIR/prompt.stderr"; then
  fail "secret prompt leaked the configured value"
fi
pass "secret prompt preserves defaults without echoing them"

echo "[test] all startup-script regression tests passed"
