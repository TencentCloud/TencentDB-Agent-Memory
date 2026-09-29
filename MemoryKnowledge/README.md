# MemoryKnowledge（Knowledge Service）

本目录是 monorepo 内的 **Knowledge Service（KS）**：用户侧 Wiki + Code-Graph 引擎。  
管控面在 [`../MemoryPanel`](../MemoryPanel/)。

默认端口 **8421**，API 前缀 **`/v3`**。

## 做什么

| 能力 | 说明 |
| --- | --- |
| **LLM-Wiki** | 上传/拉取文档 → LLM 抽取结构化页面 → FTS5 全文检索 + 知识图谱 |
| **Code-Graph** | `git clone` 仓库 → CodeGraph 索引（符号、调用、文件树）→ 探索查询 |
| **Git 凭证管理**（可选） | 托管 HTTPS token / SSH 私钥，让 Code-Graph 能索引**私有仓库**。见下文「私有仓库接入」。 |
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
```

## 私有仓库接入（Git 凭证管理）

默认只支持公开 HTTPS 仓库。要索引私有仓库，需要先托管一份凭证，再在注册仓库时引用它。

### 前置要求

| 组件 | 最低版本 | 为什么 |
| --- | --- | --- |
| git | **2.31** | 凭证通过 `GIT_CONFIG_COUNT/KEY_n/VALUE_n` 注入子进程环境，该机制需 2.31+ |
| OpenSSH | **7.6** | SSH 路径使用 `StrictHostKeyChecking=accept-new` |
| Node.js | 22 | 与项目一致 |

并配置加密主密钥（**不配则凭证接口返回 503**）：

```bash
export KNOWLEDGE_SECRET_KEY="$(openssl rand -base64 32)"
```

### 用法

```bash
# 1) 托管凭证（host 必填 —— 凭证只对它声明的主机生效）
curl -s -X POST http://127.0.0.1:8421/v3/source-credential/create \
  -H 'content-type: application/json' -H 'x-tdai-service-id: svc-A' \
  -d '{"team_id":"team-1","name":"gitlab-pat","kind":"https_token",
       "host":"gitlab.example.com","secret":"<PAT>"}'

# 2) 校验连通性（会校验 host 一致，再跑一次 git ls-remote）
curl -s -X POST http://127.0.0.1:8421/v3/source-credential/test \
  -H 'content-type: application/json' -H 'x-tdai-service-id: svc-A' \
  -d '{"team_id":"team-1","credential_id":"gc-xxxxxxxx",
       "repo_url":"https://gitlab.example.com/group/repo.git"}'

# 3) 注册仓库时引用凭证
curl -s -X POST http://127.0.0.1:8421/v3/code-graph/create \
  -H 'content-type: application/json' -H 'x-tdai-service-id: svc-A' \
  -d '{"team_id":"team-1","repo_url":"https://gitlab.example.com/group/repo.git",
       "branch":"main","credential_id":"gc-xxxxxxxx"}'
```

凭证类型与用户名对照：

| 平台 | kind | username |
| --- | --- | --- |
| GitHub PAT | `https_token` | 任意（默认 `oauth2`） |
| **GitHub App installation token** | `https_token` | **必须是 `x-access-token`** |
| GitLab PAT | `https_token` | `oauth2` |
| Bitbucket app password | `https_token` | `x-token-auth` |
| SSH deploy key | `ssh_key` | 不适用（用 `git@host:path` 形式的 URL） |

### 内网 Git 服务

企业内网 GitLab / Gitea 的地址会落在 SSRF 黑名单里（`10./172.16-31./192.168./127./` 等）。
**不要**用 `KNOWLEDGE_SSRF_CHECK=off` 一把关掉，而是显式声明白名单：

```dotenv
KNOWLEDGE_GIT_ALLOWED_HOSTS=gitlab.corp.example.com,*.internal.example.com
```

白名单只支持「精确 host」与「`*.suffix` 单层通配」，且是**锚定匹配** ——
`x.corp.example.com.attacker.com`、`evilcorp.example.com` 都不会命中。端口不参与匹配。

### 安全边界（部署前请确认）

- 密钥以 AES-256-GCM 加密后落库（主密钥派生自 `KNOWLEDGE_SECRET_KEY`，密文绑定行主键作 AAD）；
  API 只回 16 位 HMAC 指纹，**永不回显明文**。
- 凭证仅在**服务端子进程的环境变量**里出现，不写进 URL、不写进 `.git/config`、不进 argv。
  同时会清空 `credential.helper`，避免 token 被 macOS 钥匙串 / git-credential-manager 缓存。
- URL 内嵌凭证写法（`https://user:token@host/...`）已被**拒绝** —— 它会泄漏到
  `.git/config`、git stderr 与所有回显错误信息的地方。请改用 `credential_id`。
- 带 passphrase 的 SSH 私钥**不支持**（无法非交互注入），创建时返回 422。
- 凭证是 **team 级共享**的。KS 自身没有成员数据、鉴权只有一把全局 `KNOWLEDGE_SERVICE_KEY`，
  因此「谁有权操作某 team 的凭证」必须由 **Panel 侧按团队成员门控**；**KS 不应直接暴露给终端用户**。
- 建议同时设置 `KNOWLEDGE_SERVICE_KEY`，否则凭证管理接口在无鉴权下可被任意调用。

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
