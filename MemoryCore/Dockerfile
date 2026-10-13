# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────
# TencentDB-Agent-Memory — Production Image
# ──────────────────────────────────────────────────────────────────────
# Multi-stage build (requires DOCKER_BUILDKIT=1):
#   1. deps-builder: install all deps (incl. native compile toolchain)
#   2. runtime:      slim image with only runtime deps + app
#
# 配置方式: 挂载 config.yaml 到 /data/config/tdai-gateway.yaml
#   docker run -v ./config.yaml:/data/config/tdai-gateway.yaml ...
#
# Build:
#   docker build -t tencentdb-agent-memory:latest .
#
# Package manager: npm (Node.js bundled). Uses committed package-lock.json
# with npm ci for locked dependency installation. Base images and apt packages
# remain mutable; this does not guarantee bit-reproducible images.
# ──────────────────────────────────────────────────────────────────────

# Stage 1: build/install deps (with toolchain for native bindings)
FROM node:22-slim AS deps-builder

# apt 源默认走 Debian 官方，公网可直接构建。内网构建加速：
#   docker build --build-arg APT_MIRROR=mirrors.tencent.com .
ARG APT_MIRROR=deb.debian.org
RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi

# Native build toolchain (sqlite-vec, @node-rs/jieba etc.)
# 使用 BuildKit cache mount 缓存 apt 包，避免重复下载
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates

WORKDIR /build

# Copy package metadata first to maximize Docker layer cache
COPY package.json package-lock.json ./

# Install production dependencies using committed package-lock.json.
# --omit=dev preserves production dependencies and optional dependencies
# (including native bindings like @esbuild/linux-* for tsx, sqlite-vec, etc.).
RUN --mount=type=cache,id=npm-cache,target=/root/.npm \
    npm ci \
        --omit=dev \
        --omit=peer \
        --no-audit \
        --no-fund

# Now copy the rest of the source
# 注意: .dockerignore 已排除 node_modules/.git/__tests__/docs 等
COPY . .

# ──────────────────────────────────────────────────────────────────────
# Stage 2: runtime — slim image
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

ARG APT_MIRROR=deb.debian.org
RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi

# Runtime essentials only (curl for HEALTHCHECK; tini for proper signal handling)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        curl \
        tini \
        ca-certificates

WORKDIR /app

# Copy app from builder stage
COPY --from=deps-builder /build /app

# The standalone runtime does not need npm/npx or optional host/native-LLM peers.
# Install such optional backends in a separately verified custom image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Data directory (mountable as PVC in K8s)
RUN mkdir -p /data/tdai-memory /data/config

# ── Runtime configuration ──
# 配置文件路径: 挂载 yaml 到 /data/config/tdai-gateway.yaml
# 敏感凭证通过环境变量注入 (env 优先级高于配置文件)
ENV NODE_ENV=production \
    TDAI_GATEWAY_CONFIG=/data/config/tdai-gateway.yaml \
    TDAI_GATEWAY_HOST=0.0.0.0 \
    TDAI_DATA_DIR=/data/tdai-memory \
    NODE_OPTIONS="--max-old-space-size=1536"

EXPOSE 8420

# K8s-friendly health check (liveness/readiness probes still defined separately
# in the Deployment manifest — this is the local-runtime fallback).
# 默认值只写在这里，不放进 ENV：TDAI_GATEWAY_PORT 一旦成为镜像环境变量就会盖掉
# 挂载配置里的 server.port（env 优先级高于 yaml），而 8420 与 gateway 的代码默认值一致。
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -fsS http://127.0.0.1:${TDAI_GATEWAY_PORT:-8420}/health || exit 1

# Use tini as PID 1 so SIGTERM/SIGKILL propagate cleanly to Node and its
# pipeline workers, and zombie processes are reaped.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Start the Gateway. tsx is a runtime dependency so we can run TypeScript directly.
CMD ["node", "--import", "tsx", "src/gateway/server.ts"]
