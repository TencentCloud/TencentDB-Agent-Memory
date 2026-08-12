FROM node:22-slim AS base

# apt 源默认走 Debian 官方，公网可直接构建。内网构建加速：
#   docker build --build-arg APT_MIRROR=mirrors.tencent.com .
ARG APT_MIRROR=deb.debian.org
RUN if [ "$APT_MIRROR" != "deb.debian.org" ]; then \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
      sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# node:22-slim 自带 npm@10.9.8 有 arborist "edgesOut" crash（干净 `npm
# install` 稳定报 `Cannot read properties of null (reading 'edgesOut')`）。
# base 里升到 11，三个 builder stage 全部继承。
RUN npm install -g npm@11 --no-audit --no-fund

WORKDIR /app

FROM base AS panel-ui-builder
WORKDIR /build/panel-web
COPY panel/web/package*.json ./
RUN npm install --no-audit --no-fund
COPY panel/web/ ./
RUN npm run build

FROM base AS panel-builder
WORKDIR /build/panel
COPY panel/package*.json ./
RUN npm install --no-audit --no-fund
COPY panel/ ./
COPY --from=panel-ui-builder /build/panel-web/dist ./web/dist
RUN npm run build

FROM base AS knowledge-builder
WORKDIR /build/knowledge
COPY knowledge/package*.json ./
RUN npm install --no-audit --no-fund
COPY knowledge/ ./
RUN npm run build

FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PANEL_PORT=8125 \
    KNOWLEDGE_PORT=8424 \
    REMOTE_INSTANCE_ID="" \
    REMOTE_INSTANCE_NAME="" \
    REMOTE_INSTANCE_URL="" \
    REMOTE_INSTANCE_KEY="" \
    KNOWLEDGE_LLM_BINDING_SYNC=1 \
    KNOWLEDGE_LLM_PROXY_BASE_URL="" \
    LLM_MODE=proxy \
    LLM_PROTOCOL=openai \
    LLM_PROVIDER=custom \
    LLM_API_KEY="" \
    LLM_BASE_URL="" \
    LLM_MODEL=Memory-Model \
    LLM_MAX_TOKENS=32768 \
    LLM_TIMEOUT_MS=1200000 \
    KNOWLEDGE_DATA_DIR=/data/knowledge \
    KNOWLEDGE_DB_PATH=/data/knowledge/knowledge.db \
    EVALUATION_BUNDLE_ENABLED=1 \
    EVALUATION_BUNDLE_PATH=/app/evaluation/bundle/evaluation-view-bundle.json \
    EVALUATION_BUNDLE_PIN_PATH=/app/evaluation/pin/evaluation-view-bundle.sha256 \
    EVALUATION_BUNDLE_EXPECTED_SHA256=sha256:1a5083dedc77ecff1d37340661c133176b46528d152ee9e750fcc7571de84bc8 \
    EVALUATION_BUNDLE_MAX_BYTES=10485760 \
    LOG_LEVEL=info \
    LOG_FORMAT=json

# runtime stage：只拷必需文件，不带源码/文档/测试/构建配置
COPY --from=panel-builder /build/panel/dist /app/panel/dist
COPY --from=panel-builder /build/panel/node_modules /app/panel/node_modules
COPY --from=panel-builder /build/panel/package.json /app/panel/package.json
COPY --from=panel-builder /build/panel/web/dist /app/panel/web/dist

COPY --from=knowledge-builder /build/knowledge/dist /app/knowledge/dist
COPY --from=knowledge-builder /build/knowledge/node_modules /app/knowledge/node_modules
COPY --from=knowledge-builder /build/knowledge/package.json /app/knowledge/package.json
# Swagger UI 从这个路径读 openapi.yaml（src/server.ts）
COPY --from=knowledge-builder /build/knowledge/openapi.yaml /app/knowledge/openapi.yaml

# GLOBAL_SYNTHETIC Recorded E1 展示资产：原始 producer bytes + 独立 digest pin。
COPY evaluation/bundle/evaluation-view-bundle.json /app/evaluation/bundle/evaluation-view-bundle.json
COPY evaluation/pin/evaluation-view-bundle.sha256 /app/evaluation/pin/evaluation-view-bundle.sha256

COPY start-combined.sh /usr/local/bin/start-combined.sh
COPY verify-evaluation-assets.sh /usr/local/bin/verify-evaluation-assets.sh
COPY README.md /app/README.md
RUN chmod 0555 /usr/local/bin/start-combined.sh /usr/local/bin/verify-evaluation-assets.sh \
    && chmod 0444 /app/evaluation/bundle/evaluation-view-bundle.json /app/evaluation/pin/evaluation-view-bundle.sha256 \
    && chmod 0555 /app/evaluation /app/evaluation/bundle /app/evaluation/pin \
    && mkdir -p /data/knowledge /app/panel/config \
    && chown -R node:node /data/knowledge /app/panel/config

# 运行态不用 root；evaluation 资产由 root 持有且对运行用户不可写。
USER node

EXPOSE 8125 8424

HEALTHCHECK --interval=20s --timeout=8s --retries=15 --start-period=45s \
  CMD curl -fsS http://127.0.0.1:${PANEL_PORT}/health >/dev/null && curl -fsS http://127.0.0.1:${KNOWLEDGE_PORT}/health >/dev/null || exit 1

CMD ["/usr/local/bin/start-combined.sh"]
