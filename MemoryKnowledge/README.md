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

## Code-Graph 查询可用性

`POST /v3/code-graph/{search|explore|callers|callees|impact|node|status|files}` 和 `POST /v3/tools/call` 中的 Code-Graph 查询采用同一规则。`/v3/code-graph/get` 与 `/v3/tools/call` 的 `get_info` 是元信息查询，不依赖索引。

| 资产状态 | 查询结果 |
| --- | --- |
| `ready` | HTTP 200，使用最近一次成功索引；若 `sync_error` 非空，结果标记为旧索引 |
| `pending` / `processing`，已有成功索引且内存中旧实例可用 | HTTP 200，继续使用旧索引；`data` 增加 `stale: true`、`served_commit_hash` 和 `last_sync_at` |
| `pending` / `processing`，首次建图或旧实例暂不可用 | HTTP 503，`Retry-After: 2`；复制或晋升阶段也短暂返回 503 |
| `failed`，无可信索引 | HTTP 409，`error_code: "CODE_GRAPH_INDEX_FAILED"` |

503 响应保留原有的数字 `code` 字段，并增加机器可读的 `error_code`：`CODE_GRAPH_INDEX_BUILDING`（首次建图）、`CODE_GRAPH_INDEX_SWITCHING`（复制或晋升）或 `CODE_GRAPH_INDEX_UNAVAILABLE`（旧实例暂不可用）。客户端可按 `Retry-After` 重试。409 是构建失败的终态提示，需排查 `sync_error` 并重新同步。

并发调用 `POST /v3/code-graph/sync` 时，已在构建的资产仍返回 409 `busy`；跨进程同步准入冲突返回 409 和 `CODE_GRAPH_SYNC_CONFLICT`，调用方可重新读取资产状态。

每个 `KNOWLEDGE_DATA_DIR` 和 `KNOWLEDGE_DB_PATH` 只能由一个 MemoryKnowledge 进程使用。服务启动时分别取得数据根和元数据库的进程锁；若另一进程已持有其中任一锁，新进程启动失败。进程退出（包括意外终止）后，操作系统释放锁，下一次启动才会执行中断恢复。锁文件位于数据根的 `.memoryknowledge-owner.sqlite` 和元数据库旁的 `<数据库文件>.memoryknowledge-owner.sqlite`；它们只用于所有权协调。元数据库路径不能是符号链接或硬链接，以免别名绕过所有权锁。同步准入仍使用 SQLite 原子更新，阻止并发请求重复入队。多副本部署需要每个副本拥有独立的数据根和元数据库；共享存储多副本模式尚不支持。

如果启动恢复无法确认哪个索引快照已提交，资产会标记为 `failed` 并保留规范目录及 `.previous`、`.suspect` 目录供排查。此时应先备份这些目录，核对 Git HEAD、索引数据库与元数据中的提交记录，再决定如何恢复；带有未决备份目录的资产会拒绝直接 `sync`，避免覆盖可能是唯一可用的快照。

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
