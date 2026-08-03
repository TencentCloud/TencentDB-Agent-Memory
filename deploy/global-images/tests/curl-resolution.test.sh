#!/usr/bin/env bash

set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$TEST_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_fake_command() {
  local path="$1"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$path"
  chmod +x "$path"
}

make_fake_command "$TMP_DIR/docker"
make_fake_command "$TMP_DIR/curl"
make_fake_command "$TMP_DIR/custom-curl"

PATH="$TMP_DIR:/usr/bin:/bin"
# shellcheck source=../_lib.sh
source "$DEPLOY_DIR/_lib.sh"

resolved="$(CURL= find_curl)"
[[ "$resolved" == "$TMP_DIR/curl" ]] ||
  fail "PATH curl was not selected: $resolved"

resolved="$(CURL="$TMP_DIR/custom-curl" find_curl)"
[[ "$resolved" == "$TMP_DIR/custom-curl" ]] ||
  fail "explicit CURL override was not selected: $resolved"

if (CURL="missing-curl-command" find_curl) >"$TMP_DIR/missing.out" 2>&1; then
  fail "missing CURL override should fail before an HTTP request"
fi
grep -q "找不到 curl 命令" "$TMP_DIR/missing.out" ||
  fail "missing curl failure did not explain how to configure CURL"

if grep -n "/usr/bin/curl" \
  "$DEPLOY_DIR/start-memory-core.sh" "$DEPLOY_DIR/verify.sh"; then
  fail "deployment scripts must not hard-code /usr/bin/curl"
fi

grep -q 'CURL="$(find_curl)"' "$DEPLOY_DIR/start-memory-core.sh" ||
  fail "start-memory-core.sh does not resolve curl through find_curl"
grep -q 'CURL="$(find_curl)"' "$DEPLOY_DIR/verify.sh" ||
  fail "verify.sh does not resolve curl through find_curl"

[[ "$(grep -c '"$CURL"' "$DEPLOY_DIR/start-memory-core.sh")" -ge 2 ]] ||
  fail "start-memory-core.sh does not use the resolved curl command"

echo "PASS: curl resolution is portable and rejects missing commands"
