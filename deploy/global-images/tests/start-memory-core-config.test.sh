#!/usr/bin/env bash
# Run with: bash deploy/global-images/tests/start-memory-core-config.test.sh
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$TEST_DIR/.." && pwd)"
SCRIPT="$DEPLOY_DIR/start-memory-core.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  echo "[FAIL] $*" >&2
  exit 1
}

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  network | ps | run) exit 0 ;;
  inspect)
    if [[ "$*" == *"State.Status"* ]]; then
      echo running
    else
      echo none
    fi
    ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/docker"

ENV_FILE="$TMP_DIR/.env"
CONFIG_DIR="$TMP_DIR/config"
cat > "$ENV_FILE" <<EOF
MEMORY_CORE_IMAGE=example/memory-core:latest
MEMORY_CORE_PORT=8080
MEMORY_CORE_VOLUME=test-memory-core-volume
MEMORY_CORE_CONFIG_DIR=$CONFIG_DIR
MEMORY_CORE_ADMIN_KEY_FILE=$TMP_DIR/admin-key
EOF

# The remaining startup path calls the running service. Extract the real script
# through the config-preparation boundary so this test exercises its lifecycle
# without requiring a memory-core container.
PREPARE_SCRIPT="$TMP_DIR/prepare-memory-core-config.sh"
sed -n '1,/^info "启动 memory-core/p' "$SCRIPT" | \
  sed "s|^SCRIPT_DIR=.*|SCRIPT_DIR=\"$DEPLOY_DIR\"|" > "$PREPARE_SCRIPT"

run_start() {
  if ! env PATH="$FAKE_BIN:$PATH" ENV_FILE="$ENV_FILE" bash "$PREPARE_SCRIPT" "$@" \
    > "$TMP_DIR/start-memory-core.log" 2>&1; then
    cat "$TMP_DIR/start-memory-core.log" >&2
    return 1
  fi
}

DEFAULT_CONFIG="$CONFIG_DIR/tdai-gateway.yaml"
run_start
[[ -f "$DEFAULT_CONFIG" ]] || fail "first start did not generate the default config"
grep -Fq 'provider: none' "$DEFAULT_CONFIG" || fail "generated config does not contain defaults"
CONFIG_MODE="$(stat -f '%Lp' "$DEFAULT_CONFIG" 2>/dev/null || stat -c '%a' "$DEFAULT_CONFIG")"
[[ "$CONFIG_MODE" == "600" ]] || fail "generated config permissions are $CONFIG_MODE, want 600"

printf '    provider: custom\n' >> "$DEFAULT_CONFIG"
run_start
grep -Fq 'provider: custom' "$DEFAULT_CONFIG" || fail "existing config was overwritten"

run_start --force-regenerate-config
grep -Fq 'provider: custom' "$DEFAULT_CONFIG" && fail "force regeneration did not replace config"
grep -Fq 'provider: none' "$DEFAULT_CONFIG" || fail "force regeneration did not write defaults"

EXTERNAL_CONFIG="$TMP_DIR/external.yaml"
printf 'memory:\n  embedding:\n    provider: external\n' > "$EXTERNAL_CONFIG"
export MEMORY_CORE_CONFIG_FILE="$EXTERNAL_CONFIG"
run_start
unset MEMORY_CORE_CONFIG_FILE
grep -Fq 'provider: external' "$EXTERNAL_CONFIG" || fail "external config was modified"

if env PATH="$FAKE_BIN:$PATH" ENV_FILE="$ENV_FILE" \
  MEMORY_CORE_CONFIG_FILE="$TMP_DIR/missing.yaml" "$SCRIPT" >/dev/null 2>&1; then
  fail "missing external config did not fail startup"
fi

echo "[PASS] memory-core config lifecycle"
