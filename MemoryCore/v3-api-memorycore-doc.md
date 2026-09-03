# v3 接口文档 · 卷一 MemoryCore

> 服务：MemoryCore（记忆内核），端口 `8420`
> 本卷覆盖 MemoryCore 暴露的全部 `/v3/*` 接口。MemoryKnowledge（`/v3/wiki`、`/v3/code-graph` 等）见卷二，MemoryProxy 见卷三。
> 维护约定：接口变更（新增/改字段/改错误码）须在同一 PR 内更新本文档。

---

## 1. 公共约定

### 1.1 服务与端口

| 项 | 值 |
|---|---|
| 服务 | MemoryCore（记忆内核网关） |
| 端口 | 8420 |
| 方法 | 全部 `POST`（v3 是 RPC 风格，无 GET） |
| Content-Type | `application/json` |
| 健康检查 | `GET /health`（**非 v3**，无鉴权，返回裸 JSON `status/version/uptime/stores/services`，不属本文档范围） |

### 1.2 响应信封

所有 v3 接口统一返回：

```json
{ "code": 0, "message": "ok", "request_id": "abc-123", "data": { } }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| code | number | `0` 成功；非 0 失败。**注意**：skill 模块的失败 code 是 5 位数字（见 §1.6） |
| message | string | 成功固定 `"ok"`；失败为错误描述（格式见 §1.6） |
| request_id | string | 请求 ID，来自 `x-request-id` 或服务端生成 |
| data | any | 业务数据；失败时通常缺失或为 null |

### 1.3 分页约定

- 数据面 list/query 接口：`limit` 默认 `20`、上限 `100`，`offset` 默认 `0`（`paginationSchema`）。
- meta list 接口：`limit` 默认 `20`、上限 `100`、`offset` 默认 `0`（`DEFAULT_PAGINATION`），出参统一 `{ items, total, limit, offset }`。
- skill `list`：`limit` 上限 `1000`；skill `search`：`top_k` 上限 `50`。
- knowledge `list`：`pagination.limit` 上限 `1000`（`knowledgeListRequestSchema`，与 skill list 相同）。
- memory-prompt / generation-log 的 list：`limit` 默认 `20`、上限 `100`。

### 1.4 鉴权分层

v3 接口按鉴权方式分四层（均需 `Authorization: Bearer <KERNEL_AUTH_TOKEN>` 作为 Layer 1 网关闸门，`apiKey` 未配置时不强制）：

| 层 | 路由范围 | 额外鉴权 |
|---|---|---|
| 数据面 | `/v3/conversation·atomic·scenario·core/*`、`/v3/topology/*`、`/v3/skill/*`、`/v3/knowledge/*`、`/v3/chat-memory/*`、`/v3/memory-prompt/*`、`/v3/memory-generation-log/*` | `x-tdai-service-id`（实例 ID） |
| 元数据面 | `/v3/meta/*` | `x-tdai-service-id` + `x-tdai-user-key`（用户 key，`auth/verify` 免 user-key） |
| 内部运维面 | `/v3/internal/meta/*` | 仅 Bearer，**不解析** user-key |
| 实例销毁 | `/v3/instance/destroy` | 仅 Bearer apiKey（v1 风格，运维接口） |

> 隔离字段说明：数据面接口的 `team_id / agent_id / user_id / task_id` 可从 **body 或 Header** 传入（`x-tdai-team-id` / `x-tdai-agent-id` / `x-tdai-user-id` / `x-tdai-task-id`），body 优先。v3 数据面**强制** team + agent + user 三元组隔离（缺省回落到 `default` 桶）。

### 1.5 错误码语义（数据面通用）

| code | 语义 |
|---|---|
| 400 | 参数不合法（ID 缺失、互斥字段、空入参） |
| 401 | 鉴权失败 |
| 403 | 归属一致性校验失败（如 `(team_id, agent_id)` 不构成有效归属、`task_id` 不属于 `team_id`） |
| 404 | 资源不存在或不属于当前调用上下文（不暴露存在性） |
| 409 | 并发竞争超时 |
| 422 | schema 通过但业务规则不通过 |
| 429 | 频控 / 配额超限 |
| 500 | 内部错误 |
| 503 | 依赖不可用（LLM / 存储 / VDB） |

### 1.6 错误 message 格式（三类，重要）

不同模块的失败 `message` 格式不同，前端需分别处理：

| 模块 | message 格式 | HTTP code 特征 | 示例 |
|---|---|---|---|
| meta / internal-meta | `"{error_code}: {detail}"`（error_code 为 snake_case 大写） | 标准 4xx/5xx | `"team_not_found: not found: t_1"` |
| skill | `SkillCoreError.message` 原文 | **5 位数字**（40001 等） | `"SKILL_NOT_FOUND: ..."` |
| 数据面 / knowledge / chat-memory / memory-prompt / generation-log | 纯文本或纯大写枚举 | 标准 4xx/5xx | `"Knowledge not found"`、`"MEMORY_PROMPT_NOT_FOUND"`、`"Store not available"` |

---

## 2. 接口目录

| 模块 | 接口数 | 前缀 |
|---|---|---|
| L0–L3 数据面与拓扑聚合 | 19 | `/v3/conversation·atomic·scenario·core/*`、`/v3/topology/*` |
| Skill | 17 | `/v3/skill/*` |
| Knowledge 明细 | 5 | `/v3/knowledge/*` |
| Chat-Memory | 1 | `/v3/chat-memory/*` |
| Memory-Prompt | 7 | `/v3/memory-prompt/*` |
| Memory-Generation-Log | 2 | `/v3/memory-generation-log/*` |
| Meta 元数据 | 55 | `/v3/meta/*` |
| Internal Meta | 2 | `/v3/internal/meta/*` |
| Instance Destroy | 1 | `/v3/instance/destroy` |

**合计 109 个接口。**

---

## 3. 接口明细

## 3.1 L0–L3 数据面与拓扑聚合（19）

> 记忆分层：L0 原始对话（conversation）、L1 记忆原子（atomic，含 episodic/persona/instruction 三类）、L2 场景文件（scenario）、L3 核心人格（core）。
> 全部接口接受 4 ID 隔离字段（`team_id/agent_id/user_id/task_id`，body 或 Header）。
> `conversation/delete`、`atomic/delete` 等删除接口信任 Bearer + `x-tdai-service-id`，不做用户级鉴权（与面板转发前校验一致）。

### POST /v3/conversation/add

写入 L0 原始对话消息。写成功后异步触发 L1 抽取 pipeline（`notifyPipeline`）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| session_id | string | 是 | 业务会话 ID |
| messages | object[] | 是 | 1–100 条，`{ role: "user"\|"assistant", content: 1–8192 字, timestamp?, recorded_at? }` |
| team_id / agent_id / user_id / task_id | string | 否* | 隔离字段（*v3 强制 team+agent+user，缺省回落 default 桶） |

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| accepted_ids | string[] | 已接收消息 ID |
| accepted_versions | string[] | 与 accepted_ids 同序，新建固定 `v1` |
| total_count | number | 接收总数 |

**示例**

```json
// 请求
{ "session_id": "sess_1", "messages": [ { "role": "user", "content": "帮我看看这个 bug" } ] }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "accepted_ids": ["msg_1"], "accepted_versions": ["v1"], "total_count": 1 }
}
```

### POST /v3/conversation/query

分页查询 L0 消息。

**请求体**：`session_id?`、`limit?`(默认20/上限100)、`offset?`、`time_start?`、`time_end?` + 隔离字段。

**响应** `data`：`{ messages: ConversationItem[], total }`，ConversationItem = `{ id, version, role, content, timestamp?, recorded_at?, session_id?, team_id?, user_id?, agent_id? }`。

### POST /v3/conversation/search

关键词检索 L0 消息。

**请求体**：`query`(1–2048)、`limit?`(默认5/上限100)、`session_id?`、`time_start?`、`time_end?` + 隔离字段。

**响应** `data`：`{ messages: (ConversationItem & { score })[] }`。

### POST /v3/conversation/delete

按 message_ids 或 session_ids 批量删除 L0。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| message_ids | string[] | 二选一 | ≤5000 条 |
| session_ids | string[] | 二选一 | ≤100 条 |
| session_id | string | 否 | @deprecated，改用 session_ids |

**响应** `data`：`{ deleted_count: number }`。

**错误**：`400`（二者至少填一个）。

### POST /v3/conversation/count

L0 计数（**仅 v3，无 v2 入口**）。

**请求体**：`session_id?`、`time_start?`、`time_end?`。

**响应** `data`：`{ total: number }`。

---

### POST /v3/atomic/update

更新单条 L1 记忆原子（版本自增）。

**请求体**：`id`、`content`(≤8192)、`background?` + 隔离字段。

**响应** `data`：`{ id, version, updated_at }`，其中 `version` 为**字符串** `"v{n}"`（如 `"v2"`）。

> ⚠️ 版本类型不一致：`update` 返回字符串 `"v{n}"`，但 `query`/`search` 返回**数字** `number`（`r.version ?? 0`）。根源在代码（`generated/types.ts` 声明 `string "v1"`，但 `v2-schemas.ts` 又 override 成 `number`），文档无法同时满足，前端需按接口分别处理。

### POST /v3/atomic/query

分页查询 L1。

**请求体**：`type?`(episodic/persona/instruction)、`time_start?`、`time_end?`、`limit?`、`offset?` + 隔离字段。

**响应** `data`：`{ items: AtomicDetail[], total }`。

**AtomicDetail** 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 原子 ID |
| version | number | 当前版本号（**query/search 返回数字**；注意 `update` 返回字符串 `"v{n}"`，类型不一致） |
| type | string | `episodic` / `persona` / `instruction` |
| background | string? | 背景 |
| content | string | 正文 |
| created_at / updated_at | string | ISO 时间 |
| team_id / agent_id / user_id / task_id | string? | 隔离字段 |

**示例**

```json
// 请求
{ "type": "episodic", "limit": 20, "offset": 0 }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "id": "rec_1", "version": 1, "type": "episodic", "content": "下周一发版", "created_at": "2026-08-20T00:00:00Z", "updated_at": "2026-08-20T00:00:00Z" } ],
    "total": 1
  }
}
```

### POST /v3/atomic/search

关键词检索 L1。

**请求体**：`query`(1–2048)、`limit?`(默认5/上限100)、`type?`、`time_start?`、`time_end?` + 隔离字段。

**响应** `data`：`{ items: (AtomicDetail & { score })[] }`。

### POST /v3/atomic/delete

按 id 批量删除 L1。

**请求体**：`ids: string[]`（≤5000）。

**响应** `data`：`{ deleted_count: number }`。

### POST /v3/atomic/count

L1 计数（**仅 v3**）。

**请求体**：`type?`、`time_start?`、`time_end?`。

**响应** `data`：`{ total: number }`。

---

### POST /v3/scenario/ls

L2 场景文件列表（一次性全量列举，无分页）。

**请求体**：`path_prefix?`（空/不传 = 根目录递归列举）+ 隔离字段。

**响应** `data`：`{ entries: ScenarioEntry[], total }`。

**ScenarioEntry**：`{ path, summary?, version, team_id?, agent_id?, created_at, updated_at }`（目录 `version=0`，path 以 `/` 结尾）。

### POST /v3/scenario/read

读取单个 L2 文件。

**请求体**：`path`（相对路径，防穿越校验）、`version?` + 隔离字段。

**响应** `data`：`{ path, version?, content, created_at, updated_at }`。**文件不存在返回 200，content/created_at/updated_at 为 null（非 404）**。

### POST /v3/scenario/write

写入 L2 文件（自动剥 META 头）。

**请求体**：`path`、`content`、`summary?` + 隔离字段。

**响应** `data`：`{ path, version, updated_at }`。

### POST /v3/scenario/rm

删除 L2 文件/目录。

**请求体**：`path`（以 `/` 结尾 = 删目录，否则删单文件）+ 隔离字段。

**响应** `data`：无（`successEnvelope(undefined)`）。

### POST /v3/scenario/count

L2 计数（**仅 v3**）。

**请求体**：`path_prefix?`。

**响应** `data`：`{ total: number }`。

---

### POST /v3/core/read

读取 L3 核心记忆（persona.md）。

**请求体**：`version?` + 隔离字段（body 可空）。

**响应** `data`：`{ content, version?, team_id?, agent_id?, created_at, updated_at }`。**文件不存在返回 200，content 为 null**。

### POST /v3/core/write

写入 L3 核心记忆（自动剥离 Scene Navigation 与首尾空白）。

**请求体**：`content` + 隔离字段。

**响应** `data`：`{ version, updated_at }`。

### POST /v3/core/count

L3 计数（**仅 v3**）。

**请求体**：`{}`（空对象）。

**响应** `data`：`{ total: number }`。

### POST /v3/topology/task-activity/aggregate

供可信 Panel 服务按 Task 范围聚合 L0 活动，不提供普通浏览器直连能力。请求必须同时携带
Bearer、`x-tdai-service-id`，并在 body 中显式指定 Team 与 1–100 个 Task。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `team_id` | string | 是 | 单一 Team 范围 |
| `task_ids` | string[] | 是 | 去重后 1–100 个 Task |
| `user_id` | string | 否 | self-only ACL 下的用户过滤 |
| `time_start_ms` / `time_end_ms` | number | 否 | 可选毫秒时间范围，start 不得晚于 end |

**响应** `data`：

```json
{
  "items": [
    {
      "team_id": "team-1",
      "task_id": "task-1",
      "user_id": "user-1",
      "agent_id": "agent-1",
      "session_count": 2,
      "l0_message_count": 8,
      "first_seen_at": "2026-08-31T00:00:00.000Z",
      "last_seen_at": "2026-08-31T01:00:00.000Z"
    }
  ],
  "completeness": "complete",
  "truncated": false,
  "scanned_records": 8
}
```

SQLite 返回精确 `GROUP BY`；TCVDB 只读取 metadata fields 并使用 hard cap。达到 cap 时
`completeness=partial`、`truncated=true`，计数只能解释为下界。响应不包含
`message_text/content/embedding/summary`。

---

## 3.2 Skill（17）

> Skill 数据面独立存储（`skill_id` 前缀 `skl-`），团队内可读、owner 可写。身份字段放 body。
> 失败 code 为 **5 位数字**（见 §1.6），错误码映射见附录 §4.2。

### POST /v3/skill/create

创建 skill（成功后自动登记 meta_asset 并绑定到 owner agent）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| name | string | 是 | ≤64 字，须等于 frontmatter.name |
| content | string | 是 | SKILL.md 全文 |
| resources | object[] | 否 | ≤100 个，`{ path ≤512, content, encoding: "utf-8"\|"base64", mime_type?, is_executable? }` |
| metadata | object | 否 | 自定义元数据 |
| team_id / agent_id / user_id / task_id | string | 见下 | 写接口要求 team+agent+user 提供 |

> 约束：`agent_id` 必须以 `team_id` 为命名空间（有 agent 必须有 team）。

**响应** `data`：`SkillSummary`（见 §3.2 末尾统一说明）。

**错误**：`40001`(参数/frontmatter 不一致)、`42201`(重名)、`4291`(配额超限)、`50304`(skill_id 连续碰撞)。

**示例**

```json
// 请求
{ "team_id": "t_1", "agent_id": "agt_1", "user_id": "u_1", "name": "code-review", "content": "---\nname: code-review\n---\n# Code Review" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "skill_id": "skl_1", "name": "code-review", "version": 1, "status": "active", "owner_user_id": "u_1", "owner_agent_id": "agt_1", "team_id": "t_1" }
}
```

### POST /v3/skill/update

全量更新（乐观锁）。

**请求体**：`skill_id`、`expected_version`(≥1)、`content` + id 字段。

**响应** `data`：`SkillSummary`。

**错误**：`40901`(版本过期，data 带 `current_version`)、`40401`、`40301`。

### POST /v3/skill/patch

局部替换（乐观锁，string patch）。

**请求体**：`skill_id`、`expected_version`、`old_string`、`new_string`、`replace_all?` + id 字段。

**响应** `data`：`SkillSummary`。

**错误**：`40901`、`42202`(patch 不唯一)、`40401`。

### POST /v3/skill/delete

物理删除（**2026-07 变更，原为软删**）：删除全部版本 + 清 storage，级联清 meta_asset / ACL / agent 绑定。

**请求体**：`skill_id`、`expected_version`、`team_id?` + id 字段。

**响应** `data`：`{ skill_id, archived: boolean }`，`archived` 语义为「删除成功」`deleted > 0`（**非归档状态**，真删也复用该字段）。

**错误**：`40401`、`40901`、`40301`、`40302`。

### POST /v3/skill/get

按 skill_id 取详情（含 content / manifest 可选）。

**请求体**：`skill_id`、`version?`、`include_content?`(默认 true)、`include_manifest?`(默认 true) + id 字段。

**响应** `data`：`SkillSummary + { content?, manifest?, content_hash?, storage_dir? }`。

**错误**：`40401`。

### POST /v3/skill/get-by-name

按 `(team_id, agent_id, skill_name)` 唯一取详情（供 agent 工具调用时一次拿到全文）。

**请求体**：`team_id`(必)、`agent_id`(必)、`skill_name`(≤64)、`version?`、`include_content?`、`include_manifest?`。

**响应** `data`：同 `get`。

**错误**：`40401`（找不到 name 统一返回，不暴露是没 name 还是没 id）。

### POST /v3/skill/list

分页列表（默认只返回 active，需 archived 显式传 `filters.status`）。

**请求体**：`filters?`(`{ owner_agent_id?, name_prefix?, status?: ["active"\|"archived"] }`)、`pagination?`(`{ limit ≤1000, offset }`) + id 字段。

**响应** `data`：`{ items: SkillSummary[], total }`。

### POST /v3/skill/search

检索 skill。

**请求体**：`query`(≤2048)、`top_k?`(≤50)、`mode?`(bm25/embedding/hybrid)、`scope?`(="team" 时团队范围不带 owner 过滤) + id 字段。

**响应** `data`：`{ items: (SkillSummary & { score, snippet })[] }`。

### POST /v3/skill/versions

版本列表。

**请求体**：`skill_id`、`pagination?` + id 字段。

**响应** `data`：`{ items: (SkillSummary & { is_expired })[], total }`。

**错误**：`40401`(skill 不存在)。

### POST /v3/skill/files/write

写脚本/资源文件。

**请求体**：`skill_id`、`expected_version`、`files`(1–100，结构同 create 的 resources) + id 字段。

**响应** `data`：`SkillSummary`。

### POST /v3/skill/files/remove

删文件。

**请求体**：`skill_id`、`expected_version`、`paths`(1–100) + id 字段。

**响应** `data`：`SkillSummary`。

### POST /v3/skill/files/read

读单个文件。

**请求体**：`skill_id`、`path`、`version?`、`encoding?` + id 字段。

**响应** `data`：`{ content, version, size_bytes, encoding, ... }`。

### POST /v3/skill/export

导出 skill（zip）。

**请求体**：`skill_id`、`version?`、`format?`(仅 "zip") + id 字段。

**响应** `data`：`{ version, file_count, total_bytes, ... }`。

**错误**：`41301`(过大)。

### POST /v3/skill/listing

生成 `<available_skills>` 注入块（供 agent prompt）。

**请求体**：`query?`(≤2048)、`char_budget?`(0–64000，默认 8000) + id 字段。

**响应** `data`：`{ mode: "full"\|"search", listing: string, hits: [{ skill_id, version, name }] }`。

### POST /v3/skill/extract

direct-trigger 手动归档一次会话切片（等价一次独立 skill 抽取）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| user_id / team_id / agent_id | string | 是 | 均不能含 `\|` |
| messages | object[] | 是 | 1–500 条，`{ role: user\|assistant\|tool_call\|tool_result\|system, content, timestamp?, tool_name?, tool_call_id? }` |
| session_id | string | 否 | 缺省生成 `sx-` 前缀 |
| space_id | string | 否 | 缺省回落 auth.serviceId |
| task_id / reason / options | — | 否 | `options.max_iterations`(1–64) |

**响应** `data`：`{ ok: true, task_id, archived_at_ms, archive_key }`。

### POST /v3/skill/conversation/add

每轮对话结束同步调用，做拼接 + 阈值判定 + 归档（skill 抽取主链路）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| session_id / user_id / team_id / agent_id | string | 是 | 均不能含 `\|` |
| messages | object[] | 是 | 1–500 条（role 同 extract，`tool_call`/`tool_result` 必须带 tool_name+tool_call_id） |
| space_id / task_id | string | 否 | — |

**响应** `data`：`{ status: "ok"\|"archived", archived?: { task_id, archived_at_ms, archive_key, reason } }`，`archived.reason ∈ tool_calls\|bytes\|compressed\|oversize`。

**错误**：`40001`(schema/校验)、`404`(模块未启用)、`50001`。

### POST /v3/skill/conversation/force-archive

手动强制归档当前 session buffer（跳过阈值）。

**请求体**：`space_id`、`user_id`、`team_id`、`agent_id`、`session_id`（均必填）、`reason?`(≤2000)、`task_id?`。

**响应** `data`：`{ status: "empty" \| "archived", task_id?, archived_at_ms?, archive_key?, message? }`。

---

**SkillSummary 统一出参**（list/create/update 等返回）：

| 字段 | 类型 | 说明 |
|---|---|---|
| skill_id | string | 全局唯一，`skl-` 前缀 |
| name | string | 名称 |
| description | string? | 描述 |
| version | number | 版本号（单调递增） |
| is_head | boolean | 是否 head 版本 |
| status | string | `active` / `archived` |
| owner_user_id | string | owner 用户 |
| owner_agent_id | string | owner agent |
| team_id / task_id | string? | 归属 |
| created_at_ms / updated_at_ms | number | ms epoch |
| metadata | object? | 自定义元数据（若有） |

---

## 3.3 Knowledge 明细（5）

> 内核侧 knowledge **元数据明细** CRUD（团队维度管理面）。wiki/code-graph 的实际存储与运营在 MemoryKnowledge（卷二），此处仅记录明细元数据。无绑定接口（TODO）。

### POST /v3/knowledge/create

upsert 知识明细（幂等）。

**请求体**：`knowledge_id`、`type`("wiki"\|"code-graph")、`service_url`(url)、`name`、`summary?`(≤256)、`team_id`、`user_id?`、`repo_url?`、`branch?`。

**响应** `data`：`KnowledgeEntity`。

### POST /v3/knowledge/get

单查明细。

**请求体**：`knowledge_id`、`team_id?`（传了则校验归属）。

**响应** `data`：`KnowledgeEntity`。

**错误**：`404`(不存在)、`403`(team 不匹配)。

### POST /v3/knowledge/update

局部更新。

**请求体**：`knowledge_id`、`team_id?`、`name?`、`summary?`、`service_url?`、`repo_url?`、`branch?`。

**响应** `data`：`KnowledgeEntity`。

**错误**：`404`、`403`。

### POST /v3/knowledge/delete

批量删除。

**请求体**：`knowledge_ids`(1–100)、`team_id?`。

**响应** `data`：`BatchDeleteResult`（`{ deleted_ids, failed: [{ id, reason }] }`）。

### POST /v3/knowledge/list

按 team 分页列表。

**请求体**：`team_id`、`type?`、`knowledge_ids?`(≤200)、`pagination?`(`{ limit ≤1000, offset }`)。

**响应** `data`：`KnowledgeListResult`。

**通用错误**：`503`(store 不可用)、`400`(schema 失败)。

**示例**（create）

```json
// 请求
{ "knowledge_id": "wiki_1", "type": "wiki", "service_url": "https://ks.example.com/wiki_1", "name": "团队 wiki", "team_id": "t_1" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "knowledge_id": "wiki_1", "type": "wiki", "name": "团队 wiki", "team_id": "t_1" }
}
```

---

## 3.4 Chat-Memory（1）

### POST /v3/chat-memory/clear

清空若干记忆的**内容**（L0/L1/L2/L3），**保留资产**（归属/绑定/ACL 不变）。

> 鉴权：Bearer + `x-tdai-service-id` 视为可信管理员级凭据，**不做用户级 Owner 校验**（Owner 校验由面板转发前完成）。

**请求体**：`memory_ids: string[]`（1–100，自动去重去空）。

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | object[] | 每个 memory 的清空结果 |
| all_cleared | boolean | 全部成功为 true |

**items[] 字段**：`memory_id`、`cleared`、`l0_deleted`、`l1_deleted`、`profile_deleted`、`reason?`、`retryable?`、`attempts?`。

**错误**：`400`(schema)、`503`(store/storage/metadata 不可用)；单个 memory 失败不整体报错，写入 `items[]` 的 `cleared=false`。

**示例**

```json
// 请求
{ "memory_ids": ["chat_memory-t_1-agt_1"] }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "memory_id": "chat_memory-t_1-agt_1", "cleared": true, "l0_deleted": 10, "l1_deleted": 3, "profile_deleted": 1 } ],
    "all_cleared": true
  }
}
```

---

## 3.5 Memory-Prompt（7）

> 记忆提示词管理（L1/L2/L3 三层 prompt），`layer` 取值为小写 `l1`/`l2`/`l3`。

### POST /v3/memory-prompt/create

创建 prompt。

**请求体**：`name`(≤100 字)、`layer`("l1"\|"l2"\|"l3")、`prompt`(≤10000 字)。

**响应** `data`：`{ memory_prompt_id: "mp-xxx", version: 1, created_at_ms }`。

**错误**：`409`(PROMPT_LIMIT_EXCEEDED，单实例上限 500)。

### POST /v3/memory-prompt/get

三种模式（互斥）：
1. `memory_prompt_id` → 返回单条 prompt（非 active 返回 404）。
2. `layer` + (`team_id`/`agent_id`) → 解析生效 prompt（无则返回内置 fallback）。
3. 仅 `layer` → 返回列表 `{ items }`。

**请求体**：`memory_prompt_id?`、`team_id?`、`agent_id?`、`layer?`、`limit?`(默认20)、`offset?`、`time_order?`(默认 desc)。

**错误**：`404`(MEMORY_PROMPT_NOT_FOUND)。

### POST /v3/memory-prompt/update

更新 name/prompt。

**请求体**：`memory_prompt_id`、`name?`、`prompt?`（至少一个）。

**响应** `data`：`{ memory_prompt_id, version, updated_at_ms }`。

**错误**：`404`。

### POST /v3/memory-prompt/delete

批量删除（要求每个 id 都存在）。

**请求体**：`memory_prompt_ids`(1–100，去重)。

**响应** `data`：删除结果。

**错误**：`404`(有 id 不存在)。

### POST /v3/memory-prompt/set

设置生效 prompt（apply / clear）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| action | string | 是 | `apply` / `clear` |
| layer | string | 是 | l1/l2/l3 |
| memory_prompt_id | string | apply 必填 | prompt ID |
| team_id | string | 否 | 目标 team（与 agent_ids 配合） |
| agent_ids | string[] | 否 | 1–100，需 team_id |

**响应** `data`：`{ affected: number }`。

**错误**：`404`(prompt 不存在)、`400`(PROMPT_LAYER_MISMATCH，prompt 层不匹配)。

### POST /v3/memory-prompt/setting/list

生效设置列表。

**请求体**：`memory_prompt_id?`、`target_type?`(instance/team/agent)、`team_id?`、`agent_id?`、`layer?`、`limit?`、`offset?`、`time_order?`。

**响应** `data`：`{ items }`。

### POST /v3/memory-prompt/log

操作日志（默认近 7 天）。

**请求体**：`memory_prompt_id?`、`start_time?`、`end_time?`、`team_id?`、`agent_id?`、`action?`(apply/replace/clear)、`limit?`、`offset?`、`time_order?`。

**响应** `data`：`{ items }`。

> 约束：`start_time`/`end_time` 须成对，时间范围 ≤90 天。

---

## 3.6 Memory-Generation-Log（2）

> 记忆生成日志（L1/L2/L3 生成溯源），`layer` 小写 l1/l2/l3。

### POST /v3/memory-generation-log/list

日志列表（默认近 7 天，游标分页）。

**请求体**：`layer?`、`status?`(succeeded/failed)、`start_time?`、`end_time?`、`limit?`(默认20/上限100)、`cursor?`(≤512)。

**响应** `data`：列表结果。

**错误**：`503`(GENERATION_LOG_STORE_UNAVAILABLE)、`400`(INVALID_GENERATION_LOG_CURSOR)。

### POST /v3/memory-generation-log/get

两种模式：
1. `log_id` → 直接取日志。
2. `memory_id` + `layer` → 按 memory 反查生成日志。

**请求体**：`log_id?`、`memory_id?`、`layer?`（log_id 与 memory_id 二选一，memory_id 需配 layer）。

**响应** `data`：日志对象。

**错误**：`404`(MEMORY_GENERATION_LOG_NOT_FOUND)、`503`。

---

## 3.7 Meta 元数据（55）

> 元数据面 `/v3/meta/*`，鉴权 `Bearer + x-tdai-service-id + x-tdai-user-key`（`auth/verify` 免 user-key）。
> 失败 message 格式 `"{error_code}: {detail}"`，HTTP 状态由 mapErrorCode 映射（见 §4.2）。
> 所有 list 接口出参统一 `{ items, total, limit, offset }`。

### 3.7.1 User（5）

| 接口 | 鉴权 | 说明 |
|---|---|---|
| `POST /user/create` | system_admin | 建普通用户，返回 `{ user_id, user_type, created_at, default_user_key }` |
| `POST /user/create-with-key` | system_admin | 姊妹接口，可显式指定 user_key |
| `POST /user/get` | 本人/admin | 按 user_id 或 user_key 查 |
| `POST /user/delete` | admin | 批量删除 |
| `POST /user/list` | admin | 分页列表 |

**create 请求体**：`username`、`user_id?`（可指定确定性 ID）。
**create-with-key 请求体**：`username`、`user_key`。
**get 请求体**：`user_id` 或 `user_key`（二选一）。
**list 请求体**：`team_id?`、`user_ids?`(≤100)、`username?` + 分页。

**UserPublic 响应**：`{ user_id, user_type: "normal"\|"system_admin", username, created_at }`。

**示例**（create）

```json
// 请求
{ "username": "zhangsan" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "user_id": "usr_1", "user_type": "normal", "created_at": "2026-08-20T00:00:00Z", "default_user_key": "tk_xxx" }
}
```

### 3.7.2 User-Key（5）

| 接口 | 说明 |
|---|---|
| `POST /user-key/create` | 建 key，`user_id` 缺省取当前 caller |
| `POST /user-key/list` | 分页列表 |
| `POST /user-key/get` | 按 key_id 查（脱敏） |
| `POST /user-key/revoke` | 吊销 |
| `POST /user-key/update` | 更新 name/expires_at |

**create 请求体**：`user_id?`、`name?`(≤128)、`expires_at?`。

**UserKeyPublic 响应**：`{ key_id, user_id, key_prefix, name?, status: "active"\|"revoked", is_default, last_used_at?, expires_at?, created_at, revoked_at? }`。create 额外返回 `key_value`（仅此一次完整 key）。

### 3.7.3 Team（5）

| 接口 | 说明 |
|---|---|
| `POST /team/create` | 建 team |
| `POST /team/get` | 按 team_id 查 |
| `POST /team/update` | 更新（owner 不可改） |
| `POST /team/delete` | 批量删除 |
| `POST /team/list` | 按 user 列出其所属 team |

**create 请求体**：`name`、`owner_user_id`、`description?`、`status?`(active/archived)、`metadata_json?`。
**update 请求体**：`team_id`、`name?`、`description?`、`status?`、`metadata_json?`（owner 传入被 strip）。
**list 请求体**：`user_id`/`user_key`(二选一) + `name?` + 分页。

**TeamEntity 响应**：`{ team_id, name, description?, owner_user_id, status, created_at, updated_at, metadata_json }`。

### 3.7.4 Team-Member（4）

| 接口 | 说明 |
|---|---|
| `POST /team-member/add` | 加成员 |
| `POST /team-member/remove` | 移除成员 |
| `POST /team-member/list` | 成员列表 |
| `POST /team-member/get` | 单查成员 |

**add 请求体**：`team_id`、`user_id`、`role?`(admin/member/reviewer)、`status?`。
**list 请求体**：`team_id` + 分页。

**TeamMemberView 响应**：`{ id, team_id, user_id, role, joined_at, status, username }`（username 为 JOIN 所得）。

### 3.7.5 Agent（6）

| 接口 | 说明 |
|---|---|
| `POST /agent/create` | 建 agent |
| `POST /agent/get` | 按 agent_id 查 |
| `POST /agent/update` | 更新（owner 不可改） |
| `POST /agent/delete` | 批量删除 |
| `POST /agent/list` | 按 team 或 owner 列表 |
| `POST /agent/archive` | 归档 |

**create 请求体**：`team_id`、`owner_user_id`、`name`、`description?`、`prompt?`、`visibility?`、`status?`、`metadata_json?`。
**list 请求体**：`team_id`/`owner_user_id`/`owner_user_key`(至少一) + `status?`、`name?` + 分页。

**AgentEntity 响应**：`{ agent_id, team_id, owner_user_id, name, description?, prompt?, visibility, status, created_at, updated_at, metadata_json }`。

**示例**（create）

```json
// 请求
{ "team_id": "t_1", "owner_user_id": "u_1", "name": "发版助手" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "agent_id": "agt_1", "team_id": "t_1", "name": "发版助手", "status": "active" }
}
```

### 3.7.6 Task（6）

| 接口 | 说明 |
|---|---|
| `POST /task/create` | 建 task（可带 linked_agents） |
| `POST /task/get` | 按 task_id 查 |
| `POST /task/update` | 更新 |
| `POST /task/delete` | 批量删除 |
| `POST /task/list` | 按 team 或 creator 列表 |
| `POST /task/archive` | 归档 |

**create 请求体**：`team_id`、`creator_user_id`、`title`、`description?`、`source_type?`(manual/tapd/github/other)、`source_url?`、`status?`(running/completed)、`auto_assign_floating_assets?`、`risk_level?`、`metadata_json?`、`linked_agents?`(`[{ agent_id, role_in_task? }]`)。

**TaskEntity 响应**：`{ task_id, team_id, creator_user_id, title, description?, source_type, source_url?, status, auto_assign_floating_assets, risk_level?, created_at, updated_at, metadata_json }`。

### 3.7.7 Task-Agent（3）

| 接口 | 说明 |
|---|---|
| `POST /task-agent/link` | 关联 agent 到 task |
| `POST /task-agent/unlink` | 解除关联 |
| `POST /task-agent/list` | 列出 task 的 agents |

**link 请求体**：`task_id`、`agent_id`、`role_in_task?`。

**TaskAgentEntity 响应**：`{ id, task_id, agent_id, role_in_task?, status, created_at }`。

### 3.7.8 Participation-Log（2）

| 接口 | 说明 |
|---|---|
| `POST /participation-log/append` | 追加参与事件 |
| `POST /participation-log/list` | 列表（支持时间/实体过滤 + dedupe） |

**append 请求体**：`team_id`、`task_id`、`agent_id`、`user_id`（均必填）、`created_at?`、`source?`、`metadata_json?`。
**list 请求体**：`team_id` + `task_id?`、`agent_id?`、`user_id?`、`created_after?`、`created_before?`、`dedupe?` + 分页。

### 3.7.9 Asset（7）

| 接口 | 说明 |
|---|---|
| `POST /asset/create` | 登记资产（asset_id 由调用方提供） |
| `POST /asset/get` | 按 asset_id 查 |
| `POST /asset/update` | 更新 |
| `POST /asset/delete` | 批量删除 |
| `POST /asset/list` | 按 team 列表 |
| `POST /asset/list-accessible` | 按权限列出可访问资产 |
| `POST /asset/touch-usage` | 触碰使用（更新 last_used_at） |

**create 请求体**：`asset_id`、`team_id`、`asset_type`(skill/llm_wiki/code_graph/chat_memory)、`name`、`owner_user_id`、`source_type`、`description?`、`source_ref?`、`visibility?`、`status?`、`confidence?`、`expires_at?`、`content_ref?`、`metadata_json?`。
**list 请求体**：`team_id`、`asset_type?`、`status?`、`owner_user_id?`、`visibility?` + 分页。
**list-accessible 请求体**：`user_id`/`user_key`(二选一) + `team_id?`、`action?`、`asset_type?`、`agent_id?`、`visibility?`(单值或数组) + 分页。

**AssetEntity 响应**：`{ asset_id, team_id, asset_type, name, description?, owner_user_id, source_type, source_ref?, version, visibility, status, confidence?, expires_at?, last_used_at?, usage_count, content_ref?, created_at, updated_at, metadata_json }`。

### 3.7.10 Agent-Fixed-Asset（4）

| 接口 | 说明 |
|---|---|
| `POST /agent-fixed-asset/set` | 全量设置 agent 固定资产绑定 |
| `POST /agent-fixed-asset/list` | 分页列出绑定 |
| `POST /agent-fixed-asset/list-with-detail` | 带详情 + 可见性过滤 |
| `POST /agent-fixed-asset/summary-by-agents` | 多 agent 按类型聚合计数 |

**set 请求体**：`agent_id`、`bindings: [{ asset_id, asset_type, injection_mode?, priority?, created_by }]`。
**list-with-detail 请求体**：`agent_id`、`apply_visibility_filter?`、`touch_usage?` + 分页。
**summary-by-agents 请求体**：`agent_ids`(1–100 去重)、`asset_id?`。

**summary 响应**：`{ items: [{ agent_id, counts: { skill, code_graph, llm_wiki, chat_memory }, total }], total }`。

### 3.7.11 ACL（4）

| 接口 | 说明 |
|---|---|
| `POST /acl/grant` | 授权 |
| `POST /acl/revoke` | 撤销 |
| `POST /acl/list` | 按 asset 列 ACL |
| `POST /acl/check` | 权限校验 |

**grant 请求体**：`asset_id`、`subject_type`(user/team_role/agent)、`subject_id`、`permission`(read/write/delete/assign/share/use)、`effect?`(allow/deny)、`granted_by`/`granted_by_key`(二选一)。
**revoke 请求体**：`id`（**注意是 ACL 条目 `id`，非 `asset_id`**，`aclRevokeSchema`）。
**list 请求体**：`asset_id` + 分页。
**check 请求体**：`asset_id`、`action`、`user_id`/`user_key`(二选一)、`agent_id?`。

**AclEntity 响应**：`{ id, asset_id, subject_type, subject_id, permission, effect, granted_by, created_at, updated_at }`。

### 3.7.12 Auth（1）

### POST /v3/meta/auth/verify

校验 user_key，返回 caller 身份。**免 user-key**（本身就是验 key，在 `V3_NO_USER_KEY_ROUTES` 白名单，走 handler 而非鉴权中间件）。

**请求体**：`{ user_key: string }`（`authVerifySchema`，缺 user_key 走 Zod 校验 → `400`）。

**响应** `data`：`{ valid: boolean, user: UserPublic | null }`（**嵌套结构，非扁平**）。

- 合法 key：`{ valid: true, user: { user_id, user_type, username, created_at } }`
- 非法 key：`{ valid: false, user: null }`（**HTTP 仍 200，code=0，不返回 401**）

> ⚠️ 前端必须检查 `data.valid`，**不能按 401 分支处理非法 key**。`401 unauthorized: invalid_user_key` 是**其他 meta 接口**走鉴权中间件（`x-tdai-user-key` header 校验）时的行为，不是 `auth/verify` 自身的行为。

**示例**

```json
// 请求
{ "user_key": "tk_xxx" }

// 响应（合法）
{ "code": 0, "message": "ok", "request_id": "abc-123", "data": { "valid": true, "user": { "user_id": "usr_1", "user_type": "normal", "username": "zhangsan", "created_at": "2026-08-20T00:00:00Z" } } }

// 响应（非法 key，注意 code 仍为 0）
{ "code": 0, "message": "ok", "request_id": "abc-123", "data": { "valid": false, "user": null } }
```

### 3.7.13 Instance-Quota & Config（3）

| 接口 | 说明 |
|---|---|
| `POST /instance-quota/get` | 取实例配额限制 |
| `POST /config/user/get` | 取用户配置（需 owner） |
| `POST /config/user/set` | 设用户配置（需 owner） |

**config get 请求体**：`user_id`、`module`、`param_name?`。
**config set 请求体**：`user_id`、`module`、`params: Record<string, string>`。

---

## 3.8 Internal Meta（2）

> `/v3/internal/meta/*`，运维/控制面，仅 Bearer（不解析 user-key）。

### POST /v3/internal/meta/user/init-admin

初始化 system_admin 用户（首次引导）。

**请求体**：`username`、`user_key?`。

**响应** `data`：`{ user_id, user_key }`。

**错误**：`409`(already_initialized)。

### POST /v3/internal/meta/user/list-by-instance

按实例列出用户（支持 status/user_type 过滤）。

**请求体**：`instance_id?`、`status?`、`user_type?`(normal/system_admin)、`user_ids?`(≤100) + 分页。

**响应** `data`：`{ items, total, limit, offset }`。

---

## 3.9 Instance Destroy（1）

### POST /v3/instance/destroy

彻底清理实例全部数据（state/store/COS/quota + v3 metadata 分库）。**仅 Bearer apiKey（运维接口，不走 user-key）**。

**请求体**：`{ instance_id: string }`。

**响应** `data`：`{ instance_id, cleaned: { state, store_evicted, skill_store_evicted, ..., v3_metadata } }`。

**错误**：`400`(缺 instance_id)。

---

## 4. 附录

### 4.1 废弃接口（v1 / v2，不在本卷正文）

| 类别 | 路径 | 说明 |
|---|---|---|
| v1 旧版 | `POST /recall`、`/capture`、`/search/memories`、`/search/conversations`、`/session/end`、`/seed` | 已被 v3 数据面拆分替代（hermes 迁移文档已列映射） |
| v2 数据面 | `/v2/conversation·atomic·scenario·core/*`（14 条） | 与 v3 同一 handler 双入口；无 count 接口；isolation 校验较松（team 可选、可走 legacyCompat） |
| v2 entity | `/v2/team·user·agent·task/*`（16 条） | @deprecated，改用 `/v3/meta/*`，计划删除 |
| v2 运维 | `/v2/pipeline/status`、`/v2/instance/destroy` | instance/destroy 有 v3 版本；pipeline/status 仅 v2 |

### 4.2 错误码汇总

#### Skill（5 位数字 code）

| code | SkillCoreError | 说明 |
|---|---|---|
| 40001 | INVALID_FRONTMATTER / INVALID_PATH | frontmatter 不一致 / 路径非法 |
| 40301 | SKILL_NOT_OWNER | 非 owner |
| 40302 | SKILL_TEAM_MISMATCH | team 不匹配 |
| 40401 | SKILL_NOT_FOUND | skill 不存在 |
| 40901 | SKILL_VERSION_STALE | 版本过期（data 带 current_version） |
| 41002 | SKILL_VERSION_EXPIRED | 版本过期（data 带 latest_version） |
| 41301 | RESOURCE_TOO_LARGE / SKILL_EXPORT_TOO_LARGE | 资源过大 |
| 42201 | SKILL_NAME_DUPLICATE | 重名 |
| 42202 | SKILL_PATCH_NOT_UNIQUE | patch 不唯一 |
| 42203 | SKILL_FRONTMATTER_INVALID | frontmatter 非法 |
| 4291 | — | 配额超限（memory limit exceeded） |
| 50001 | 其他 | 内部错误 |
| 50301 | STORAGE_NOT_FOUND | 存储/版本目录 GC 缺失 |
| 50302 | LLM_UNAVAILABLE | LLM 不可用 |
| 50303 / 50304 | SKILL_COS_REQUIRED / SKILL_ID_COLLISION | COS 缺失 / ID 碰撞 |

#### Meta / Internal-Meta（标准 HTTP code，message 带 error_code）

| HTTP | error_code | 说明 |
|---|---|---|
| 400 | missing_instance_id / invalid_instance_id / missing_team_id / filter_not_allowed / invalid_user_ids | 参数/实例非法 |
| 401 | invalid_credentials / invalid_password / unauthorized | 鉴权失败 |
| 403 | permission_denied / agent_team_mismatch / task_agent_not_linked / user_inactive | 权限/归属 |
| 404 | `*_not_found`（team/agent/task/asset/user_key 等） | 资源不存在 |
| 409 | duplicate_entry / duplicate_user_key / key_limit_exceeded / user_limit_exceeded / team_limit_exceeded / last_key_cannot_revoke / already_initialized / last_system_admin / member_already_exists / asset_not_bindable | 冲突/超限 |

#### 数据面 / knowledge / chat-memory / memory-prompt / generation-log（标准 HTTP code，message 纯文本或枚举）

| HTTP | message 示例 | 说明 |
|---|---|---|
| 400 | 字段校验失败文本 | Zod schema 失败 |
| 403 | Knowledge team_id mismatch | 归属不一致 |
| 404 | Knowledge not found / MEMORY_PROMPT_NOT_FOUND / MEMORY_GENERATION_LOG_NOT_FOUND | 资源不存在 |
| 409 | PROMPT_LIMIT_EXCEEDED | 超限 |
| 503 | Store not available / Storage not available / Metadata service not available / GENERATION_LOG_STORE_UNAVAILABLE | 依赖不可用 |
