# MemoryKnowledge（Knowledge Service）

本目录是 monorepo 内的 **Knowledge Service（KS）**：用户侧 Wiki + Code-Graph 引擎。  
管控面在 [`../MemoryPanel`](../MemoryPanel/)。

默认端口 **8421**，API 前缀 **`/v3`**。

## 做什么

| 能力 | 说明 |
| --- | --- |
| **LLM-Wiki** | 上传/拉取文档 → LLM 抽取结构化页面 → FTS5 全文检索 + 知识图谱 |
| **Code-Graph** | `git clone` 仓库 → CodeGraph 索引（符号、调用、文件树）→ 探索查询 |
| **Auto-Sync**（可选） | 定时扫描 code-graph，FIFO 队列 + worker pool 自动拉取 git 更新并重建索引。默认关闭，见 `docs/data-flow.md` §9。 |
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
│   ├── mcp/                # MCP stdio（转发到本机 HTTP API）
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

## 通过 API 创建可在 Panel 中使用的 Wiki

Wiki 在 KS 中的内容记录与 MemoryCore 中的 `meta_asset` 是两份不同的记录。直接调用 KS 的 `POST /v3/wiki/create` 只创建前者；成功返回 `wiki_id` 不代表已完成 Panel 所需的资产登记。Panel 的详情、页面和图谱接口会先查询 Core 的资产及访问权限，因此缺少登记时可能返回 `asset_not_found`，即使 KS 中已有 Wiki。

与 Panel 集成的调用方应优先使用 **Panel** 的 `POST /api/v1/knowledge/wiki/create`。该接口先验证用户和 Team 成员身份，再调用 KS 创建 Wiki，并以返回的 `wiki_id` 登记 Core 资产。

下面使用用户 Key 调用；`PANEL_URL` 是 Panel 根地址，端口以实际部署为准。`SERVICE_ID` 必须是 Panel 已配置的实例 ID，`USER_KEY` 必须属于该实例中目标 Team 的有效成员；不要用供应商 LLM Key 代替用户 Key。

```bash
PANEL_URL='http://127.0.0.1:8123'
SERVICE_ID='default'
# 在当前终端设置 USER_KEY 为用户 Key；不要把真实 Key 写进文档或提交到仓库。
: "${USER_KEY:?请先设置用户 Key}"

curl --fail-with-body -sS "$PANEL_URL/api/v1/knowledge/wiki/create" \
  -H 'Content-Type: application/json' \
  -H "x-tdai-service-id: $SERVICE_ID" \
  -H "x-tdai-user-key: $USER_KEY" \
  --data '{"team_id":"team-REPLACE-ME","name":"API Wiki"}'
```

将 `team-REPLACE-ME` 替换为已有 Team 的 ID。检查响应的 `code`：成功为 `0`，Wiki ID 位于 **`data.wiki_id`**，不是顶层字段；非零时先处理错误，不要继续上传或摄入。创建成功也不表示已完成文档抽取。

后续仍向 Panel 发 POST 请求，并携带相同的实例和用户 Key 请求头：

| 步骤 | Panel 路径 | JSON 请求字段 |
| --- | --- | --- |
| 上传源文件 | `/api/v1/knowledge/wiki/raw/write` | `team_id`、`wiki_id`、`files: [{"filename":"intro.md","content":"文档内容"}]` |
| 启动摄入 | `/api/v1/knowledge/wiki/ingest` | `wiki_id` |
| 查看状态与详情 | `/api/v1/knowledge/wiki/get` | `wiki_id` |

使用创建响应中的 `wiki_id`，并保持 Team 与实例一致。先上传源文件再启动摄入，随后通过详情中的 `data.status` 检查处理结果；摄入请求被接受不等于处理成功。

### 已直接调用 KS 创建 Wiki 的集成

若选择自行编排底层 API，顺序是 **KS `/v3/wiki/create` → Core `/v3/meta/asset/create` → 上传源文件 → 摄入**。这两个服务使用各自的地址和认证配置；不要把 Core 的路径发给 KS，也不要把实例 ID 当成认证凭证。Core 登记仍须通过其用户权限校验。对应同一实例时，登记字段应与 KS 返回记录一致：

| Core `asset/create` 字段 | 值 |
| --- | --- |
| `asset_id` | KS 返回的 `data.wiki_id`，不可另造 ID |
| `asset_type` | `llm_wiki` |
| `team_id` | 创建 Wiki 时的 Team ID |
| `name` | KS 返回的 `data.name` |
| `owner_user_id` | 经过认证的实际创建用户 ID |
| `source_type` | `manual` |
| `visibility` | `team`（Panel 创建流程使用的值） |
| `content_ref` | KS 返回的 `data.service_url`（若有） |

先核对该实例中是否已有同 ID 的资产，避免重复创建或覆盖他人的记录；若 KS 创建成功而 Core 登记失败，应保留 `wiki_id` 并处理登记错误。这是跨服务调用，不是一次原子事务。已有 Wiki 的补登记只解决资产发现与权限记录，不能证明其摄入成功，也不会修复丢失的文件或索引。

具体实现可对照 [Panel Wiki 创建路由](../MemoryPanel/src/panel/http/routes/knowledge/wiki-routes.ts)、[资产登记函数 `ensureKnowledgeAsset`](../MemoryPanel/src/panel/http/routes/knowledge/common.ts) 和 [KS Wiki API 定义](openapi.yaml)。

## 常用命令

```bash
pnpm dev          # HTTP API（tsx 热更）
pnpm dev:mcp      # MCP stdio（另开终端；需 HTTP 已起）
pnpm typecheck
pnpm test
pnpm build        # tsdown → dist/
```

## 可选：ClickHouse 工具调用埋点

默认关闭。设置以下环境变量后，Knowledge Service 会把 `POST /v3/tools/call` 写入与 Memory/Skill 兼容的 `tool_call_logs`；启动时会幂等建表，批写或建表失败均不阻断业务请求。

```dotenv
KNOWLEDGE_CLICKHOUSE_ENABLED=true
KNOWLEDGE_CLICKHOUSE_URL=http://clickhouse.example.com:8123
KNOWLEDGE_CLICKHOUSE_DATABASE=default
KNOWLEDGE_CLICKHOUSE_TABLE=tool_call_logs
KNOWLEDGE_CLICKHOUSE_USER=knowledge_writer
KNOWLEDGE_CLICKHOUSE_PASSWORD=              # 仅从环境注入，不写入代码
```

可选调优项见 `.env.example`。若调用方传入 `x-conversation-id`、`x-tdai-user-id`、`x-tdai-team-id`、`x-tdai-agent-id`、`x-tdai-agent-source`、`x-tdai-space-id`、`x-tdai-turn-seq`，这些维度会一并入库；缺失时对应列为空。请求正文递归脱敏并截断到 512 bytes。

## 可选：Langfuse

配置 `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`（及可选 `LANGFUSE_BASE_URL`）即可上报 Wiki LLM 调用。  
未配置时关闭 Trace，不影响业务。
