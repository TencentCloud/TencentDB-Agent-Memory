# syntax=docker/dockerfile:1
# Knowledge Service — production image (HTTP :8421)
#
# Build:
#   DOCKER_BUILDKIT=1 docker build -t team-knowledge:0.1.0 .
#
# Run (CLI flags, no .env):
#   docker run -d -p 8421:8421 -v team-knowledge-data:/app/data team-knowledge:0.1.0 \
#     --public-url http://203.0.113.10:8421/v3 \
#     --tmc-callback http://203.0.113.10:8123 \
#     --llm-key sk-xxx --llm-base-url https://api.example.com/v1

# ── Stage 1: build ──
FROM node:22-slim AS builder

# apt 源默认走 Debian 官方，公网可直接构建。内网构建加速：
#   docker build --build-arg APT_MIRROR=mirrors.tencent.com .
ARG APT_MIRROR=deb.debian.org
RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node:22-slim 自带 npm@10.9.8 有 arborist "edgesOut" bug（Cannot read
# properties of null (reading 'edgesOut')）—— 干净 `npm install` 稳定挂。
# 升到 npm@11 规避；不影响其它构建行为。
RUN npm install -g npm@11 --no-audit --no-fund

COPY package.json .npmrc* ./
RUN --mount=type=cache,id=npm-cache-knowledge,target=/root/.npm \
    npm install --no-audit --no-fund

COPY tsconfig.json tsdown.config.ts ./
COPY src/ ./src/
# Swagger UI 运行时要读的 spec（见 src/server.ts）。放在包根而非 docs/，
# 镜像因此完全不依赖文档目录。
COPY openapi.yaml ./openapi.yaml

RUN npm run build
RUN npm prune --omit=dev

# ── Stage 2: runtime ──
FROM node:22-slim AS runtime

ARG APT_MIRROR=deb.debian.org
RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/openapi.yaml ./openapi.yaml
COPY --from=builder /app/package.json ./

COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker/smoke-test.sh /usr/local/bin/smoke-test.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/smoke-test.sh \
    && mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=8421 \
    KNOWLEDGE_DATA_DIR=/app/data \
    KNOWLEDGE_DB_PATH=/app/data/knowledge.db \
    LOG_LEVEL=info

EXPOSE 8421

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8421/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["start"]
