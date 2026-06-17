# 配置说明（memory-tencentdb CodeBuddy Skill）

本 Skill 不自带存储，而是通过本地 Gateway（`src/gateway/server.ts`，默认 `http://127.0.0.1:8420`）访问 TencentDB Agent Memory 的四层记忆管线。Gateway 的配置写在：

```
$TDAI_DATA_DIR/tdai-gateway.json
# 默认: ~/.memory-tencentdb/memory-tdai/tdai-gateway.json
```

所有配置都由 `scripts/memory-tencentdb-ctl.sh config <段>` 子命令以 0600 权限原子写入，密钥在 `config show` 时自动脱敏。

---

## 1. 三块必需配置

记忆要完整工作（召回 + 提取 + 检索），通常需要三块配置：

| 段 | 作用 | 必需性 |
|----|------|--------|
| **PostgreSQL** | 存储 L0/L1/L2/L3 数据 + 向量/全文检索（默认后端） | 必需 |
| **LLM** | L1 结构化记忆提取、画像生成 | 必需（否则只有 L0 原始会话） |
| **Embedding** | 生成向量，支撑语义召回 | 强烈建议（否则降级为关键词检索） |

可通过安装脚本一次性写入，或事后单独配置。

### 一次性安装（推荐）

```bash
bash scripts/install-codebuddy-skill.sh --user \
  --pg-database mydb --pg-user myuser --pg-password 'secret' \
  --pg-host 127.0.0.1 --pg-port 5432 --pg-schema agent_memory \
  --llm-base-url https://api.openai.com/v1 --llm-api-key 'sk-...' --llm-model gpt-4o \
  --emb-provider openai --emb-base-url https://api.openai.com/v1 \
  --emb-api-key 'sk-...' --emb-model text-embedding-3-small --emb-dimensions 1536 \
  --restart
```

### 事后单独配置

```bash
CTL=scripts/memory-tencentdb-ctl.sh   # 或仓库内 scripts/ 下的同名脚本
bash $CTL config postgres --database mydb --user myuser --password 'secret' --restart
bash $CTL config llm --base-url https://api.openai.com/v1 --api-key 'sk-...' --model gpt-4o --restart
bash $CTL config embedding --provider openai --base-url https://api.openai.com/v1 \
     --api-key 'sk-...' --model text-embedding-3-small --dimensions 1536 --restart
bash $CTL config show   # 查看（已脱敏）
```

---

## 2. PostgreSQL 配置项

通过 `config postgres` 写入 `memory.postgres.*`，并自动把 `memory.storeBackend` 切为 `postgres`。

| 参数 | 默认 | 说明 |
|------|------|------|
| `--database` | `postgres` | 数据库名（必填） |
| `--user` | `postgres` | 用户（必填） |
| `--password` | — | 口令；trust/peer 认证可不填 |
| `--host` | `127.0.0.1` | 主机 |
| `--port` | `5432` | 端口 |
| `--schema` | `agent_memory` | 记忆表所在 schema |
| `--ssl` / `--no-ssl` | 关 | 是否启用 SSL |
| `--pool-max` | `5` | 连接池大小 |
| `--statement-timeout-ms` | `10000` | SQL 超时 |
| `--text-config` | `simple` | BM25 文本配置；中文检索可填 `jieba`（需 `pg_jieba`） |
| `--vector-index` | `hnsw` | `none` / `hnsw` / `ivfflat` / `diskann` |
| `--use-vector-scale` / `--no-vector-scale` | — | `diskann` 时尝试 StreamingDiskANN |
| `--no-set-backend` | — | 只写连接，不切换 storeBackend |

> 完整后端设计与字段含义见仓库 `docs/design/postgres-backend.md`。

### PostgreSQL 扩展依赖

| 扩展 | 用途 | 可选 |
|------|------|------|
| `vector`（pgvector） | 向量类型 / `<=>` 操作符 / HNSW、IVFFlat 索引 | **否**（缺失则向量检索完全降级） |
| `pg_textsearch` | BM25 全文检索（`<@>` 操作符 + `bm25` 索引） | 是（缺失降级为无 FTS）。还需在 `shared_preload_libraries` 中加载 |
| `vectorscale` | StreamingDiskANN（`--vector-index diskann` 时试用） | 是 |
| `pg_jieba` | 中文分词（`--text-config jieba`，映射 `public.jiebacfg`） | 是 |

Gateway 初始化时会 `CREATE EXTENSION IF NOT EXISTS vector` 等；若 DB 用户无创建扩展权限，请预先由 DBA 安装：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
-- 可选：
CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
```

---

## 3. LLM / Embedding 配置项

### LLM（`config llm`）

| 参数 | 说明 |
|------|------|
| `--base-url` | OpenAI 兼容端点，必须 `http(s)://` 开头 |
| `--api-key` | 密钥 |
| `--model` | 模型名（如 `gpt-4o`） |

### Embedding（`config embedding`）

| 参数 | 说明 |
|------|------|
| `--provider` | `openai` / `deepseek` / `qclaw` / … 或 `none`（关闭向量检索） |
| `--base-url` | 端点 |
| `--api-key` | 密钥 |
| `--model` | 模型名 |
| `--dimensions` | 向量维度（如 1536、1024），需与 PG 向量索引一致 |
| `--proxy-url` | 仅 `provider=qclaw` 需要 |

> 修改 embedding provider/model/dimensions 后，Gateway 会按 `embedding_meta` 自动判断是否需要 reindex。

---

## 4. 用户级 vs 项目级（记忆隔离/共享）

| 维度 | 用户级 `--user` | 项目级 `--project` |
|------|----------------|--------------------|
| 安装位置 | `~/.codebuddy/skills/memory-tencentdb` | `<workspace>/.codebuddy/skills/memory-tencentdb` |
| session_key | `codebuddy:global` | `codebuddy:proj:<workspace 路径哈希>` |
| 记忆作用域 | 跨所有项目共享 | 按项目隔离 |
| 适用 | 个人长期偏好、跨项目习惯 | 项目专属上下文、与协作者共享（随仓库提交） |

`session_key` 在安装时写入 `scripts/.session-scope`，`memory-client.mjs` 自动读取。可用 `--session <key>` 临时覆盖，或设环境变量 `TDAI_MEMORY_SESSION_KEY`。

> 注意：用户级与项目级默认共用同一个 PostgreSQL（同一 `tdai-gateway.json`），靠 `session_key` 做逻辑隔离。若要物理隔离，可为项目级单独指定不同 `--pg-schema` 并使用独立 Gateway 数据目录（设 `TDAI_DATA_DIR`）。

---

## 5. 环境变量

| 变量 | 作用 |
|------|------|
| `TDAI_GATEWAY_BASE_URL` | 客户端目标 Gateway 地址（默认 `http://127.0.0.1:8420`） |
| `TDAI_GATEWAY_API_KEY` | Gateway 鉴权 Bearer token（Gateway 启用鉴权时） |
| `TDAI_MEMORY_SESSION_KEY` | 覆盖 session_key |
| `MEMORY_TENCENTDB_GATEWAY_HOST` / `_PORT` | Gateway 监听地址（默认 `127.0.0.1:8420`） |
| `MEMORY_TENCENTDB_CTL` | 显式指定 `memory-tencentdb-ctl.sh` 路径（供 `gateway-up.sh` 定位） |
| `TDAI_DATA_DIR` / `MEMORY_TENCENTDB_ROOT` | Gateway 数据目录 / 统一根目录 |

---

## 6. 安全

- 密钥 / 口令以 0600 写入 `tdai-gateway.json`；`config show` 自动脱敏。
- Gateway 默认绑定 `127.0.0.1` 且无鉴权（仅本机可访问）。如需暴露到非回环地址，**必须** 设 `TDAI_GATEWAY_API_KEY` 并让客户端用 `--api-key` 传 Bearer。
- 客户端 recall/capture 失败一律静默降级，不在回答或日志中回显密钥与堆栈。
