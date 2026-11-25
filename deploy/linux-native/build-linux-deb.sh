#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION=22.23.5
NODE_HOME=
OUTPUT_DIR="$SCRIPT_DIR/out"
PROXY=
SKIP_PAYLOAD_BUILD=0
SKIP_NPM_INSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-version) NODE_VERSION="$2"; shift 2 ;;
    --node-home) NODE_HOME="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --skip-payload-build) SKIP_PAYLOAD_BUILD=1; shift ;;
    --skip-npm-install) SKIP_NPM_INSTALL=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This script must run on Linux x86_64." >&2
  exit 1
fi
command -v dpkg-deb >/dev/null || { echo "Missing build tool: dpkg-deb" >&2; exit 1; }
if [[ $SKIP_PAYLOAD_BUILD -eq 0 ]]; then
  ARGS=(--node-version "$NODE_VERSION" --output-dir "$OUTPUT_DIR")
  [[ -n "$NODE_HOME" ]] && ARGS+=(--node-home "$NODE_HOME")
  [[ -n "$PROXY" ]] && ARGS+=(--proxy "$PROXY")
  [[ $SKIP_NPM_INSTALL -eq 1 ]] && ARGS+=(--skip-npm-install)
  "$SCRIPT_DIR/build-linux-x64.sh" "${ARGS[@]}"
fi
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
PACKAGE_DIR="$OUTPUT_DIR/TencentDB-Agent-Memory-linux-x64"
[[ -x "$PACKAGE_DIR/runtime/node/bin/node" ]] || { echo "Linux payload not found: $PACKAGE_DIR" >&2; exit 1; }
VERSION=1.0.2
PACKAGE_NAME="tdai-memory_${VERSION}_amd64"
STAGING="$SCRIPT_DIR/.cache/deb-staging"
rm -rf "$STAGING"
mkdir -p "$STAGING/DEBIAN" "$STAGING/opt"
cp -a "$PACKAGE_DIR" "$STAGING/opt/tdai-memory"
for script in control postinst prerm postrm; do
  cp "$SCRIPT_DIR/debian/$script" "$STAGING/DEBIAN/$script"
done
chmod 755 "$STAGING/DEBIAN/postinst" "$STAGING/DEBIAN/prerm" "$STAGING/DEBIAN/postrm"
INSTALLED_SIZE="$(du -sk "$STAGING" | cut -f1)"
printf 'Installed-Size: %s\n' "$INSTALLED_SIZE" >>"$STAGING/DEBIAN/control"
DEB="$OUTPUT_DIR/$PACKAGE_NAME.deb"
dpkg-deb --build --root-owner-group "$STAGING" "$DEB"
(cd "$OUTPUT_DIR" && sha256sum "$PACKAGE_NAME.deb" >"$PACKAGE_NAME.deb.sha256")
echo "Debian package created: $DEB"
