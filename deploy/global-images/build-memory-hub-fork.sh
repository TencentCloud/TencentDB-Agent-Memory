#!/usr/bin/env bash
# build-memory-hub-fork.sh
# 构建 memory-hub fork 固化镜像：官方 agentmemory/memory-hub:latest +
# 本地编译产物覆盖（panel/dist 后端 + web/dist 前端）。
# 构建产物默认 tag：agentmemory/memory-hub:fork（可用 MEMORY_HUB_FORK_IMAGE 覆盖）。
#
# 用法：
#   ./build-memory-hub-fork.sh
# 构建后把 .env 的 MEMORY_HUB_IMAGE 指向新 tag，重跑 start-all.sh 即可。
#
# 前置：本地已编译 MemoryPanel（npm run build × 2，见 Dockerfile 注释）。
# Windows 注意：清空 NODE_OPTIONS 后再编译，否则 vite 的 rmSync 被
# safe-delete shim 拦截导致构建失败。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="${MEMORY_HUB_FORK_IMAGE:-agentmemory/memory-hub:fork}"

if ! docker image inspect agentmemory/memory-hub:latest >/dev/null 2>&1; then
  echo "基础镜像 agentmemory/memory-hub:latest 不存在，先拉取..."
  docker pull agentmemory/memory-hub:latest
fi

# ── 本地编译（幂等：产物比源码新则跳过）─────────────────────────────
cd "$REPO_ROOT/MemoryPanel"
if [[ -f dist/index.js && -f web/dist/index.html ]] && \
   [[ dist/index.js -nt src/index.ts && web/dist/index.html -nt web/src/main.tsx ]]; then
  echo "检测到已编译产物（dist 新于源码），跳过编译。"
else
  echo "编译 panel 后端（tsc → dist/）..."
  env -u NODE_OPTIONS npm run build
  echo "编译 web 前端（vite → web/dist/）..."
  (cd web && env -u NODE_OPTIONS npm run build)
fi

CONTEXT_DIR="$(mktemp -d)"
trap 'rm -rf "$CONTEXT_DIR" 2>/dev/null || true' EXIT

echo "准备构建上下文（仅编译产物）..."
cp -r "$REPO_ROOT/MemoryPanel/dist" "$CONTEXT_DIR/panel-dist"
cp -r "$REPO_ROOT/MemoryPanel/web/dist" "$CONTEXT_DIR/web-dist"

CONTEXT_WIN="$(cygpath -w "$CONTEXT_DIR")"
DOCKERFILE_WIN="$(cygpath -w "$SCRIPT_DIR/Dockerfile.memory-hub-fork")"

echo "构建 $TAG ..."
docker build \
  -f "$DOCKERFILE_WIN" \
  -t "$TAG" \
  "$CONTEXT_WIN"

echo "构建完成：$TAG"
echo "下一步：.env 设置 MEMORY_HUB_IMAGE=$TAG 后重跑 ./start-all.sh"
