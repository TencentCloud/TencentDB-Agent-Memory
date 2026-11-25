#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_VERSION=22.23.5
NODE_HOME=
OUTPUT_DIR="$SCRIPT_DIR/out"
PROXY=
SKIP_NPM_INSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-version) NODE_VERSION="$2"; shift 2 ;;
    --node-home) NODE_HOME="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --skip-npm-install) SKIP_NPM_INSTALL=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ -n "$PROXY" ]]; then
  export HTTPS_PROXY="$PROXY"
  export HTTP_PROXY="$PROXY"
fi
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This script must run on Linux x86_64 so native npm modules match the target." >&2
  exit 1
fi
for command in curl tar sha256sum; do
  command -v "$command" >/dev/null || { echo "Missing build tool: $command" >&2; exit 1; }
done
CACHE_DIR="$SCRIPT_DIR/.cache"
mkdir -p "$CACHE_DIR" "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
download() {
  local url="$1" destination="$2"
  local args=(-fL --retry 3 "$url" -o "$destination")
  if [[ -n "$PROXY" ]]; then
    args=(--proxy "$PROXY" "${args[@]}")
  fi
  curl "${args[@]}"
}
if [[ -z "$NODE_HOME" ]]; then
  ARCHIVE="$CACHE_DIR/node-v$NODE_VERSION-linux-x64.tar.xz"
  SUMS="$CACHE_DIR/node-v$NODE_VERSION-SHASUMS256.txt"
  [[ -f "$ARCHIVE" ]] || download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$ARCHIVE"
  [[ -f "$SUMS" ]] || download "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" "$SUMS"
  EXPECTED=
  while read -r hash filename; do
    if [[ "$filename" == "node-v$NODE_VERSION-linux-x64.tar.xz" ]]; then
      EXPECTED="$hash"
      break
    fi
  done <"$SUMS"
  [[ -n "$EXPECTED" ]] || { echo "Node.js checksum entry not found." >&2; exit 1; }
  echo "$EXPECTED  $ARCHIVE" | sha256sum -c -
  NODE_HOME="$CACHE_DIR/node-v$NODE_VERSION-linux-x64"
  if [[ ! -x "$NODE_HOME/bin/node" ]]; then
    tar -C "$CACHE_DIR" -xJf "$ARCHIVE"
  fi
fi
NODE_HOME="$(cd "$NODE_HOME" && pwd)"
NODE="$NODE_HOME/bin/node"
VERSION="$("$NODE" --version)"
[[ "$VERSION" == v22.* ]] || { echo "Node.js 22 is required; found $VERSION" >&2; exit 1; }
export PATH="$NODE_HOME/bin:$PATH"
NPM_TOOLING_DIR="$CACHE_DIR/npm11"
NPM_CLI="$NPM_TOOLING_DIR/node_modules/npm/bin/npm-cli.js"
if [[ ! -f "$NPM_CLI" ]]; then
  "$NODE_HOME/bin/npm" install --prefix "$NPM_TOOLING_DIR" npm@11 --no-audit --no-fund
fi
run_npm() {
  local directory="$1"
  shift
  (cd "$directory" && "$NODE" "$NPM_CLI" "$@")
}
if [[ $SKIP_NPM_INSTALL -eq 0 ]]; then
  run_npm "$REPO_ROOT/MemoryCore" install --ignore-scripts --legacy-peer-deps --omit=peer --no-audit --no-fund
  run_npm "$REPO_ROOT/MemoryKnowledge" ci --no-audit --no-fund
  run_npm "$REPO_ROOT/MemoryPanel" ci --no-audit --no-fund
  run_npm "$REPO_ROOT/MemoryPanel/web" ci --no-audit --no-fund
  run_npm "$REPO_ROOT/MemoryProxy" install --package-lock-only --ignore-scripts --no-audit --no-fund
  run_npm "$REPO_ROOT/MemoryProxy" ci --no-audit --no-fund
fi
run_npm "$REPO_ROOT/MemoryCore" run build:plugin
for target in build:migrate-sqlite-to-vdb build:export-tencent-vdb build:read-local-memory; do
  run_npm "$REPO_ROOT/MemoryCore" run "$target"
done
run_npm "$REPO_ROOT/MemoryKnowledge" run build
run_npm "$REPO_ROOT/MemoryKnowledge" run typecheck
run_npm "$REPO_ROOT/MemoryPanel" run build
run_npm "$REPO_ROOT/MemoryPanel" run typecheck
run_npm "$REPO_ROOT/MemoryPanel/web" run build
run_npm "$REPO_ROOT/MemoryProxy" run typecheck
PACKAGE_DIR="$OUTPUT_DIR/TencentDB-Agent-Memory-linux-x64"
rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR/app" "$PACKAGE_DIR/runtime"
for component in MemoryCore MemoryKnowledge MemoryPanel MemoryProxy; do
  SOURCE="$REPO_ROOT/$component"
  DESTINATION="$PACKAGE_DIR/app/$component"
  mkdir -p "$DESTINATION"
  tar -C "$SOURCE" \
    --exclude='./.git' --exclude='./data' --exclude='./coverage' \
    --exclude='./__tests__' --exclude='./.archive-tmp' --exclude='./z_config' \
    -cf - . | tar -C "$DESTINATION" -xf -
done
cp -a "$NODE_HOME" "$PACKAGE_DIR/runtime/node"
cp -a "$SCRIPT_DIR/config" "$SCRIPT_DIR/scripts" "$SCRIPT_DIR/systemd" "$PACKAGE_DIR/"
chmod +x "$PACKAGE_DIR/scripts"/*.sh
cp "$REPO_ROOT/LICENSE" "$PACKAGE_DIR/LICENSE.txt"
cp "$NODE_HOME/LICENSE" "$PACKAGE_DIR/runtime/node/LICENSE.txt"
SOURCE_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$PACKAGE_DIR/build-info.json" <<EOF
{
  "node": "$VERSION",
  "platform": "linux-x64",
  "sourceRevision": "$SOURCE_REVISION",
  "builtAtUtc": "$BUILT_AT"
}
EOF
echo "Linux x64 package created: $PACKAGE_DIR"
