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

## 常用命令

```bash
pnpm dev          # HTTP API（tsx 热更）
pnpm dev:mcp      # MCP stdio（另开终端；需 HTTP 已起）
pnpm typecheck
pnpm test
pnpm build        # tsdown → dist/
pnpm wiki-sync    # 把 Wiki 投影到本地 Git 仓库（见下节）
```

## Wiki ⇄ 本地 Git 仓库（`knowledge-wiki-sync`）

Wiki 是活的那一份，checkout 是它的工作副本。每次运行把**两边都与上次同步的状态**比较，谁变了就应用谁（`page/write` / `page/rm` 反向写回 Wiki）：

| 变化 | 结果 |
| --- | --- |
| 只有 Wiki 变了 | 写入 checkout |
| 只有（已提交的）git 变了 | 写入 Wiki |
| 两边都变了、内容不同 | **冲突**：两边都不写，退出码 2 |
| 两边都变了、内容相同 | 已收敛，无事发生 |
| 两边都没变 | 无事发生 |

```bash
pnpm build                                       # 命令读 dist/
export KNOWLEDGE_API_URL=http://127.0.0.1:8421
export KNOWLEDGE_SERVICE_ID=<service_id>        # 即 x-tdai-service-id
export KNOWLEDGE_API_TOKEN=<bearer>             # 可选
pnpm wiki-sync -- --wiki-id wiki-xxxxxxxx --repo /path/to/checkout [--push]
```

三条底线：

- **只认提交。** git 侧取的是**已提交的树**，不取工作区。未提交的改动只作为 drift 报告，不进 Wiki —— 半成品编辑进不去，未提交的删除也删不掉页面。
- **冲突即整体中止。** 半个合并比不前进更糟；不静默丢弃任何一边，是唯一安全的结论。要强制选边用 `--on-conflict=prefer-git|prefer-wiki`。
- **删除是对称的**，且逐条按名打日志 —— 这是唯一无法靠重读恢复的操作。

| 行为 | 说明 |
| --- | --- |
| 路径 | 与 API ref 命名空间 1:1 —— `wiki/products/x/x.md` 原样落到仓库 |
| 内容 | 每次运行结束后两边逐字节相同（服务写入会注入 `locked: true`，所以写回后重新读取再落盘） |
| 边界 | `media/` 与结构性文件 `schema.md`/`purpose.md` 永不写入、永不删除 |
| 首次运行 | 以 Wiki 为准重建 checkout；checkout 里的既有内容**不作为输入** |
| 安全 | 任一页读不到即整体中止、不落盘；页面列表为空则拒绝执行（除非 `--allow-empty`） |
| 状态 | 存于 `<git-dir>/wiki-sync-state.json`（每 checkout 一份，从不入库）：上次同步的 commit + 每页内容哈希 |

其他开关：`--dry-run`（只报计划）、`--no-commit`（只写树，不保存状态）、`--api-url` / `--service-id` / `--token`。定时（cron）跑即可；两边都不变时不会产生提交。

部署两点（两者都是实测踩到的）：

- **服务启用了鉴权时**（`KNOWLEDGE_SERVICE_KEY` 非空），写端点 `/wiki/page/write`、`/wiki/page/rm` 需要 `Bearer` —— 把该 key 用 `--token`（或 `KNOWLEDGE_API_TOKEN`）传入；只读端点（`page/ls`、`page/read`、`wiki/get`）仍在白名单里，无需鉴权。
- **git 提交需要身份**：目标 checkout 必须有 `user.name` / `user.email`（用仓库级或全局配置），否则第一次提交会失败。

合并镜像（`deploy/panel-knowledge-combined`）会把 `knowledge/bin/` 一并打进 runtime，因此也可在容器内直接跑：

```bash
docker exec tdai-memory-hub node /app/knowledge/bin/wiki-sync.mjs --help
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
