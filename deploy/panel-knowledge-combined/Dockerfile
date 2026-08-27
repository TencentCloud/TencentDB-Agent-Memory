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
    TDAI_AGENT_TEMPLATE_DIR=/data/knowledge/agent-templates \
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

COPY start-combined.sh /usr/local/bin/start-combined.sh
COPY README.md /app/README.md
RUN chmod +x /usr/local/bin/start-combined.sh && mkdir -p /data/knowledge /app/panel/config

EXPOSE 8125 8424

HEALTHCHECK --interval=20s --timeout=8s --retries=15 --start-period=45s \
  CMD curl -fsS http://127.0.0.1:${PANEL_PORT}/health >/dev/null && curl -fsS http://127.0.0.1:${KNOWLEDGE_PORT}/health >/dev/null || exit 1

CMD ["/usr/local/bin/start-combined.sh"]
