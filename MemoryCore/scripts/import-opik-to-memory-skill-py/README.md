# Opik → Memory Core Skill 导入工具（Python 版）

**只用 Python 标准库，无第三方依赖**，Python 3.9+ 直接跑。

## 三个子命令

- `list-projects` — 只列 Opik 项目
- `fetch` — 从 Opik 拉数据 + 聚合成本地 session JSON 文件（不写 core）
- `import` — 把本地 session 文件灌到 Memory Core

**推荐做法：fetch 与 import 分开**。fetch 完就可以断开 Opik，import 慢慢跑；import 有断点续传（默认开），跑一半挂了重来只补差量。

## 与 TS 版（`../import-opik-to-memory-skill/`）的关系

| 维度 | TS 版 | Python 版 |
|---|---|---|
| 拉取 vs 灌入 | 一步 | **两步分离**（fetch → import） |
| 依赖 | Node ≥ 22.16 + `npm install` | Python 3.9+，零依赖 |
| 灌入分批 | 按字节/条数打包 | **按"一轮对话"分批**（一个 user + 它后面的 assistant/tool_call/tool_result） |
| 灌入节奏 | 尽量快 | 每轮 sleep（默认 3s），Opik 全局限流 500ms |
| 断点续传 | 有 | **import 有，per-session 粒度** |
| 抽取产出统计 | 会轮询 `skill/list` 收敛 | 不查，产出去 UI 或 `/v3/skill/list` 看 |

## 前置条件

- Python 3.9+
- Opik REST API 可达
- Memory Core Gateway 业务接口（`/v3/skill/*`）通
- Memory Core 侧 skill 抽取 + LLM 都在跑（否则 0 产出）
- `team_id` + `agent_id` 已在 metadata 层注册
  - ⚠️ agent id 是 `agt-xxx` 而不是 `apt-xxx`；在 metadata `/api/v1/meta/asset/list-accessible` 里查到的 `asset_id` 是 `skl-*`（skill 主键），对应 `agent_id` 需要用 core 的 `/v3/skill/list` 反查 `owner_agent_id`

## 只有密钥用环境变量，其余都是命令行参数

刻意这样设计：env 容易搞错、忘记 unset、被其他进程继承。身份类参数（`--team-id / --agent-id / --user-id / --service-id / --memory-url / --opik-url`）**必须在命令行显式给**，让每次调用都能看清打向的是哪个环境。

密钥只从环境变量读，不接受 CLI 参数（避免出现在 shell history / `ps aux`）:

```bash
export MEMORY_CORE_API_KEY='ck_xxx.xxx'
# Opik 开鉴权时才需要：
# export OPIK_API_KEY='...'
# export OPIK_AUTH_SCHEME='Bearer'
```

> `user_id` / `team_id` / `agent_id` / `session_id` 不能含 `|`（Redis 队列元素分隔符），脚本启动时会校验。

## 用法

### 1. 列 Opik 项目

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py list-projects \
  --opik-url 'http://<opik-host>:5173'
```

不需要 Memory Core 参数或密钥。

### 2. Fetch —— 只从 Opik 拉数据到本地

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '3367b740' \
  --out-dir ./opik-dump-3367b740
```

- `--project` 支持 id 精确 / name 精确 / id 前缀 / name 前缀
- 输出目录里每个 session 一个 `.json` 文件（`session_id + .json`，非法字符转 `-`）
- 目录里还有一个 `manifest.json`，写了项目 id、trace 数、session 数、抓取时间
- 默认跳过已存在的文件；加 `--overwrite` 才会覆盖

**重要**：fetch 只压 Opik、不压 Memory Core，两者解耦。

### 3. Import —— 从本地目录灌到 Memory Core

```bash
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx \
  --agent-id agt-xxx \
  --user-id  usr-xxx \
  --task-id  opik-import-2026-08 \
  --concurrency 5 \
  --turn-gap-ms 2000
```

首次跑就会看到粗略 ETA：

```
[import] 总 sessions=87 (已完成 0, 待办 87) 总 turns=412 待办 turns=412
[import] 并发=5 turn-gap=2000ms → 粗略 ETA ~2m44s（HTTP 耗时另计）
```

跑的过程中每完成一个 session 会打一行进度：

```
[progress] sessions 12/87  turns 68/412  elapsed 34s  ETA ~2m5s
```

断点保存在 `--in-dir/.import-state.json`（可用 `--state-file` 覆盖）。挂了重跑会自动跳过已完成的 session；要强制重灌加 `--no-resume`。

### Dry-run

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --dry-run
```

不会真发 core、不写断点，只走一遍分组逻辑。dry-run 也要给身份参数（脚本要读进去校验、算 ETA）。

## 参数对照

### `fetch`

| 参数 | 默认 | 说明 |
|---|---:|---|
| `--project` | **必填** | id / name / 前缀 |
| `--out-dir` | **必填** | 输出目录 |
| `--max-traces` | 0 | 从 Opik 拉 trace 数上限（0=不限） |
| `--max-sessions` | 0 | 只保留前 N 个 session |
| `--page-size` | 100 | Opik 分页 size |
| `--opik-request-gap-ms` | 500 | Opik 请求最小间隔（保护 Opik） |
| `--include-system` | 关 | 保留 system 消息（默认丢弃） |
| `--overwrite` | 关 | 覆盖已有文件 |

### `import`

| 参数 | 默认 | 说明 |
|---|---:|---|
| `--in-dir` | **必填** | fetch 生成的目录 |
| `--max-sessions` | 0 | 只灌前 N 个 session |
| `--concurrency` | 2 | 不同 session 之间并发上限 |
| `--turn-gap-ms` | 3000 | 同 session 每轮间隔 |
| `--no-force-archive` | 关 | 不做尾部 force-archive |
| `--dry-run` | 关 | 只读不写 |
| `--state-file` | `<in-dir>/.import-state.json` | 断点文件 |
| `--no-resume` | 关 | 忽略断点 |

## 数据流

```
Opik /projects
    ↓ (选中 project)
Opik /traces?project_id=...   (分页；每次请求全局限流 500ms)
    ↓
按 thread_id 聚合 → 同 thread 只保留消息数最多的那条 trace（累积快照）
    ↓
本地 JSON 文件：<out-dir>/<session_id>.json
    ↓ (fetch 结束；此时可断开 Opik)
    ↓ (import 开始)
读本地文件 → 每个 session 切成"一轮对话"
    ↓
concurrency=N 并发跑不同 session；同 session 内串行
    ↓
每一轮 POST /v3/skill/conversation/add (同 session_id)
    ↓ sleep turn-gap-ms
    ↓
force-archive 兜底 → 记入断点
```

**几个关键点**：
- 同一个 session 始终用同一个 `session_id`；每次只推一轮对话
- 同 session 一轮之间 sleep（默认 3s），不同 session 并发
- Opik 抓取全局最小间隔（默认 500ms）
- import 断点粒度是 session；session 内某轮失败会 warn 并继续下一轮

## 抽取阈值

服务端 `add-handler` 满足任一条件触发归档：

| 条件 | 阈值 |
|---|---:|
| `tool_call` 累计条数 | 10 |
| 字节累计 | 40 KB |
| 单次请求字节 | ≥ 40 KB 立即压缩归档 |

如果一个 session 里 tool_call 不多、内容也不长，只有 `force-archive` 那一下会归档；抽取器判"不值得沉淀" → 0 skill，这是**正常结果**。

## 快速验证（1 个 session，链路验通）

```bash
# fetch 1 个 session
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '019ed0c0' --out-dir /tmp/opik-smoke \
  --max-sessions 1 --max-traces 20

# 灌进 core
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir /tmp/opik-smoke \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --turn-gap-ms 1000
```

## 已知限制

- 不做 SWE-bench 之类的评测数据过滤（选 project 时手工避开）
- 抽取产出不查，稍后自己看 UI / `/v3/skill/list`
- 单 session 内一轮失败会 warn 继续，不整体回滚（下次重跑同 session 内容一致，不会重复归档？—— 会重复；断点粒度是 session，session 内不细分。如果单轮失败很多，可以删掉这个 session 的断点条目重跑）
