#!/usr/bin/env bash
# build-proxy-fork.sh
# 构建 fork 固化镜像：官方 agentmemory/memory-proxy:latest + 本地 MemoryProxy/src 覆盖。
# 构建产物默认 tag：agentmemory/memory-proxy:fork（可用 PROXY_FORK_IMAGE 覆盖）。
#
# 用法：
#   ./build-proxy-fork.sh
#   PROXY_FORK_IMAGE=my-registry/memory-proxy:fork ./build-proxy-fork.sh
# 构建后把 .env 的 PROXY_IMAGE 指向新 tag，重跑 start-proxy.sh 即可。
#
# 说明：构建上下文用临时目录（只含 src/），避免把整个仓库（MemoryPanel 等）
# 发送给 docker daemon，构建更快。Windows/Git Bash 下用 cygpath 把上下文
# 转成 Windows 路径再传给 docker（否则路径转换错乱，报 GetFileAttributesEx）。

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAG="${PROXY_FORK_IMAGE:-agentmemory/memory-proxy:fork}"

if ! docker image inspect agentmemory/memory-proxy:latest >/dev/null 2>&1; then
  echo "基础镜像 agentmemory/memory-proxy:latest 不存在，先拉取..."
  docker pull agentmemory/memory-proxy:latest
fi

CONTEXT_DIR="$(mktemp -d)"
trap 'rm -rf "$CONTEXT_DIR" 2>/dev/null || true' EXIT

echo "准备构建上下文（仅 src/）..."
cp -r "$REPO_ROOT/MemoryProxy/src" "$CONTEXT_DIR/src"

# Git Bash → Windows 原生 docker：把路径转成 C:\ 形式
CONTEXT_WIN="$(cygpath -w "$CONTEXT_DIR")"
DOCKERFILE_WIN="$(cygpath -w "$SCRIPT_DIR/Dockerfile.proxy-fork")"

echo "构建 $TAG ..."
docker build \
  -f "$DOCKERFILE_WIN" \
  -t "$TAG" \
  "$CONTEXT_WIN"

echo "构建完成：$TAG"
echo "下一步：.env 设置 PROXY_IMAGE=$TAG 后重跑 ./start-proxy.sh"
