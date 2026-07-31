# MemoryKnowledge（Knowledge Service）

本目录是 monorepo 内的 **Knowledge Service（KS）**：用户侧 Wiki + Code-Graph 引擎。  
管控面在 [`../MemoryPanel`](../MemoryPanel/)。

默认端口 **8421**，API 前缀 **`/v3`**。

## 做什么

| 能力 | 说明 |
| --- | --- |
| **LLM-Wiki** | 上传/拉取文档 → LLM 抽取结构化页面 → FTS5 全文检索 + 知识图谱 |
| **Code-Graph** | `git clone` 仓库 → CodeGraph 索引（符号、调用、文件树）→ 探索查询 |
| **Tools** | `POST /v3/tools/list`、`/v3/tools/call`，供 Agent / Kernel 自发现调用 |
| **状态回调** | ingest/sync 完成后回调 Panel（`TMC_CALLBACK_URL`），再写远端 meta / knowledge |

单独 `pnpm dev` 可以起服务；产品链路里必须有 Panel 推 `llm_binding`、收 callback、写远端元数据。

## 源码结构

```text
MemoryKnowledge/
├── src/
│   ├── server.ts           # Hono 入口：挂路由、Swagger、启动监听
│   ├── module.ts           # 组装 store / wiki / code-graph / 队列 / 恢复
│   ├── config.ts           # 环境变量
│   ├── callback.ts         # → Panel status-callback
│   ├── telemetry.ts        # 可选 Langfuse（未配 KEY 则关闭）
│   ├── routes/             # wiki / code-graph / tools / llm-binding / health
│   ├── engines/
│   │   ├── wiki/           # ingest-v2、索引、图谱搜索
│   │   └── code/           # CodeGraph bridge
│   ├── store/              # SQLite（Drizzle）+ 构建队列 + llm_binding
│   ├── source-fetcher/     # Git 拉取
│   ├── mcp/                # MCP stdio + streamable-HTTP（转发到本机 HTTP API）
│   ├── db/                 # schema / client
│   └── middleware/
├── docs/                   # 设计与 API 细节
├── Dockerfile              # KS 单镜像（可选）
└── docker-compose.yml      # 本地一键跑 KS 容器（可选）
```

## 本地启动

生产/联调若要用 **Panel + KS 一体镜像**，直接拉 [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)（用法见 [`../deploy/panel-knowledge-combined/README.md`](../deploy/panel-knowledge-combined/README.md)）。下面是只跑本服务源码的方式：

```bash
cd MemoryKnowledge
pnpm install --ignore-workspace
cp .env.example .env
# 编辑 .env（见下）
pnpm dev
```

```bash
curl -s http://127.0.0.1:8421/health
# Swagger: http://127.0.0.1:8421/docs
```

与 Panel 联调时（Panel 默认 `8123`），KS `.env` 至少：

```dotenv
PORT=8421
API_PREFIX=/v3
KNOWLEDGE_DATA_DIR=./data
KNOWLEDGE_DB_PATH=./data/knowledge.db
KNOWLEDGE_PUBLIC_BASE_URL=http://127.0.0.1:8421/v3   # Agent 可达，必须含 /v3
TMC_CALLBACK_URL=http://127.0.0.1:8123               # Panel 根地址，不要带 callback path
LLM_MODE=proxy
LLM_MODEL=Memory-Model
```

Panel 侧（Panel 自己的 `.env`，不是 KS）：

```dotenv
KNOWLEDGE_SERVICE_URL=http://127.0.0.1:8421
```

| 变量 | 谁读 | 带 `/v3`？ |
| --- | --- | --- |
| `KNOWLEDGE_PUBLIC_BASE_URL` | KS → 写入资源 `service_url` | 要 |
| Panel `KNOWLEDGE_SERVICE_URL` | Panel → 调 KS 管理 API | 不要 |
| `TMC_CALLBACK_URL` | KS → 回调 Panel | 不要（只填根） |

`LLM_MODE=proxy`（默认）：Wiki 用 Panel 按 `x-tdai-service-id` 推送的 `llm_binding`，本地不必起 Proxy。  
`LLM_MODE=custom`：在 `.env` 设 `LLM_API_KEY` / `LLM_BASE_URL`（及可选 `LLM_PROTOCOL=anthropic`）。

## 常用命令

```bash
pnpm dev          # HTTP API（tsx 热更）
pnpm dev:mcp      # MCP stdio（另开终端；需 HTTP 已起）
pnpm typecheck
pnpm test
pnpm build        # tsdown → dist/
```

## MCP 接入

Knowledge Service 提供两种 MCP 接入方式，暴露相同的 12 个只读查询工具（Wiki 4 + CodeGraph 8）：

### stdio（本地进程）

```bash
pnpm dev:mcp
# Agent 配置 command: node dist/mcp/server.js
```

### Streamable-HTTP（远程网络接入）

KS 启动后自动在 `/mcp` 挂载标准 MCP streamable-HTTP 端点，远程 Agent 直接用 URL 接入：

```
https://<host>:<port>/mcp
```

**启用鉴权（生产环境必填）：**

```dotenv
KNOWLEDGE_MCP_AUTH_TOKEN=your-secret-token
```

设置后所有 MCP 请求必须携带 `Authorization: Bearer your-secret-token`。  
留空（默认）则不鉴权，仅适合本地开发。

**Agent 配置示例（标准 mcpServers 格式）：**

```json
{
  "mcpServers": {
    "agent-memory-knowledge": {
      "url": "https://agent-memory.example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

## 可选：Langfuse

配置 `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`（及可选 `LANGFUSE_BASE_URL`）即可上报 Wiki LLM 调用。  
未配置时关闭 Trace，不影响业务。
