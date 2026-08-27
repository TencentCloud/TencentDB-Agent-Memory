# MemoryPanel 接口文档

> 服务：MemoryPanel（管控面板），端口 `8125`

---

## 1. 公共约定

### 1.1 Base URL 与端口

| 项 | 值 |
|---|---|
| Base URL | `/api/v1`（`/health` 除外） |
| 端口 | 8125 |
| 方法 | 除 `GET /health`、`GET /api/v1/meta/instances` 外，**其余全部为 `POST`**（RPC 风格） |
| Content-Type | `application/json` |

### 1.2 鉴权

绝大多数业务接口依赖以下 Header（由中间件 `validatePanelMetaHeaders` 校验）：

| Header | 必填 | 说明 |
|---|---|---|
| `x-tdai-service-id` | 是 | 实例 ID，用于定位目标内核网关（`instanceRegistry.resolve`） |
| `x-tdai-user-key` | 是* | 当前用户 key，用于内核侧 `auth/verify` 反查 caller 身份 |
| `x-request-id` | 否 | 透传到响应信封 `request_id`，用于日志关联 |

> `*` 例外：`POST /meta/auth/verify`（免 user-key，因为它本身就是验 key 的）；`POST /knowledge/status-callback`（S2S 回调，无浏览器 header）；`GET /health`、`GET /meta/instances`（无鉴权）。

### 1.3 响应信封

所有业务接口统一返回：

```json
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| code | number | `0` 成功；非 0 失败 |
| message | string | 成功固定 `"ok"`；失败为大写下划线错误枚举（稳定契约，前端按此分支） |
| request_id | string | 请求 ID，来自 `x-request-id` 或服务端生成 |
| data | any | 业务数据；失败时为 `null` |

> 例外：`GET /health` 与 `GET /meta/instances` **不返回信封**，直接返回裸 JSON（见 §3.1）。

### 1.4 HTTP 状态映射

`HTTP status = envelope.code` 的映射规则：

| envelope.code | HTTP status |
|---|---|
| `0` | `200` |
| `400 ~ 599` | 同 `code` |
| 其余 | `502` |

### 1.5 分页约定

- 内核 list 接口默认 `DEFAULT_PAGINATION = { limit: 20 }`：**前端直接调 `meta/*` 的 list action 若不传 limit，只返回前 20 条**。
- Panel 层聚合/业务接口（如 `chat-memory/*`、`knowledge/*/team-assets`）内部已用分页拉全量，无需前端翻页。
- `task/list-with-agents` 的 `limit` 上限 200；不传时内核按默认 20 条返回，但响应 `limit` 字段回显 50（已知不一致，见 §3.5）。

### 1.6 幂等约定

- 知识类 create 接口（`wiki/create`、`code-graph/create`）靠同名/同资源幂等复用：重复创建返回已有资源，而非报错。
- 创建类 `meta/*` action（`user/create`、`team/create`、`agent/create`、`task/create`）在 Panel 层先查重，重名返回 `409` 中文提示。

### 1.7 请求 ID 链路

`x-request-id`（可选）→ 透传进信封 `request_id` → 转发内核时也携带，用于跨服务日志关联。

---

## 2. 接口目录

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（无鉴权，裸 JSON） |
| GET | `/api/v1/meta/instances` | 实例列表（无鉴权，裸 JSON） |
| POST | `/api/v1/meta/*` | 元数据透明代理（53 个 action，见 §3.2） |
| POST | `/api/v1/skill/*` | Skill 数据面透明代理（15 个 action，见 §3.3） |
| POST | `/api/v1/chat-memory/team-assets` | 团队记忆资产列表 |
| POST | `/api/v1/chat-memory/agent-fixed` | 指定 Agent 的固定资产记忆 |
| POST | `/api/v1/chat-memory/my-agents` | 我的 Agent 记忆（一 agent 一块） |
| POST | `/api/v1/chat-memory/mine` | 我 owner 的记忆资产列表 |
| POST | `/api/v1/chat-memory/create` | 创建独立记忆资产（mem-xxx） |
| POST | `/api/v1/chat-memory/import` | 导入历史对话到 Agent 的 L0 |
| POST | `/api/v1/chat-memory/patch-scope` | 改记忆可见性（team ↔ private） |
| POST | `/api/v1/chat-memory/set-agent-fixed` | 批量设置 Agent 固定记忆 |
| POST | `/api/v1/chat-memory/allocate` | 分配（借入）记忆到 Agent |
| POST | `/api/v1/chat-memory/unbind` | 从 Agent 解绑记忆 |
| POST | `/api/v1/chat-memory/layer` | L0/L1/L2/L3 分层懒加载 |
| POST | `/api/v1/chat-memory/clear` | 一键清空记忆内容（保留资产） |
| POST | `/api/v1/chat-memory/layer-delete` | 分层批量删除（L0/L1） |
| POST | `/api/v1/chat-memory/layer-update` | 分层编辑（L1/L2/L3） |
| POST | `/api/v1/chat-memory/search` | 分层关键词检索（L0/L1） |
| POST | `/api/v1/task/list-with-agents` | Task 列表聚合（含 linked agents） |
| POST | `/api/v1/agent-overview/bootstrap` | Agent 概览引导数据聚合 |
| POST | `/api/v1/agent/delete-cascade` | 删除 Agent（级联清 skill 后 archive） |
| POST | `/api/v1/knowledge/wiki/*` | Wiki 知识库业务路由（14 个，见 §3.8） |
| POST | `/api/v1/knowledge/code-graph/*` | Code-Graph 业务路由（8 个，见 §3.9） |
| POST | `/api/v1/knowledge/allocate` 等 | 知识分配/授权（5 个，见 §3.10） |
| POST | `/api/v1/knowledge/status-callback` | KS 状态回调（S2S） |
| POST | `/api/v1/knowledge/{type}/team-assets` | 团队知识资产池（2 个，见 §3.12） |

---

## 3. 接口明细

## 3.1 健康检查与实例

### GET /health

健康检查。无鉴权，无请求体，**返回裸 JSON（非信封）**。

**响应**

```json
{ "status": "ok" }
```

### GET /api/v1/meta/instances

返回实例列表。无鉴权，无请求体，**返回裸 JSON（非信封）**。

**响应**

```json
{
  "instances": [
    {
      "instance_id": "inst_1",
      "name": "测试实例",
      "gateway_endpoint": "https://memory.ap-beijing.tencenttdai.com"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| instances | object[] | 实例公开信息列表（`instanceRegistry.listPublic()`，**`api_key` 是 secret 不下发**） |
| instances[].instance_id | string | 实例 ID |
| instances[].name | string | 实例名称 |
| instances[].gateway_endpoint | string | Panel → Kernel 转发地址（非 secret，前端用于拼接客户端接入地址） |
| instances[].proxy_endpoint | string? | 可选，客户端接入 baseUrl；未配置则前端回落 `gateway_endpoint` |

---

## 3.2 元数据透明代理

### POST /meta/*

将 `{ action, ...payload }` 转发到内核 `/v3/meta/{action}`，信封原样透传。这是 Panel 对内核元数据面（user/team/agent/task/asset/acl 等）的统一入口。

**鉴权**：`x-tdai-service-id` + `x-tdai-user-key`（仅 `auth/verify` 免 user-key）。

**转发语义**：
- 请求体整体透传给内核对应 action；响应信封原样返回。
- 路径最后一段即 action 名（如 `POST /meta/agent/list` → 内核 `agent/list`）。
- 白名单之外 action 返回 `404 UNKNOWN_META_ACTION`；`agent-fixed-asset/*` 返回 `501 NOT_IN_SCOPE`（该类操作由 Panel 业务路由内部直调，见 §3.4/§3.10）。

**开放 action 清单（53 条）**：

| 实体 | action |
|---|---|
| user | create、create-with-key、get、delete、list |
| user-key | create、list、get、revoke、update |
| team | create、get、update、delete、list |
| team-member | add、remove、list、get |
| agent | create、get、update、delete、list、archive、set-default-template、get-default-template |
| task | create、get、update、delete、list、archive |
| task-agent | link、unlink、list |
| participation-log | append、list |
| asset | create、get、update、delete、list、list-accessible、touch-usage |
| acl | grant、revoke、list、check |
| auth | verify |
| instance-quota | get |
| config/user | get、set |

**未开放（`501 NOT_IN_SCOPE`）**：`agent-fixed-asset/set`、`agent-fixed-asset/list`、`agent-fixed-asset/list-with-detail`、`agent-fixed-asset/summary-by-agents`。

**Panel 层特殊处理（不纯透传）**：

| action | 行为 |
|---|---|
| `user/create`、`user/create-with-key`、`team/create`、`agent/create`、`task/create` | 先按 name/username/title 查重，重名返回 `409` 中文提示 |
| `agent/set-default-template` | **不转发内核**，Panel 本地写模板文件；需 `system_admin` 权限，否则 `403 permission_denied`；缺 `team_id`/`template` 返回 `400 INVALID_PARAM` |
| `agent/get-default-template` | **不转发内核**，Panel 本地读模板文件 |
| `team-member/add` | 成功后异步为默认 Agent 复制模板资产（best-effort） |
| `user/list` | 隐藏内部 `knowledge-service` 计费用户 |

**示例**（`agent/create`）：

```json
// 请求
POST /api/v1/meta/agent/create
{ "team_id": "t_1", "owner_user_id": "u_1", "name": "发版助手" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "agent_id": "agt_xxx", "name": "发版助手" }
}
```

---

## 3.3 Skill 数据面透明代理

### POST /skill/*

将 `{ action, ...payload }` 转发到内核 `/v3/skill/{action}`，信封原样透传。

**鉴权**：`x-tdai-service-id` + `x-tdai-user-key`（强制，skill 需要 owner 身份）。

**与 `/meta/*` 的差异**：
- Skill 数据面有独立存储（`skill_id` 前缀 `skl-`）：团队内可读、owner agent 可写。
- 身份字段（`user_id` / `team_id` / `agent_id` / `task_id`）放 **body**，不放 Header。
- 分页用嵌套 `pagination.{limit, offset}`，body 原样透传。

**开放 action 清单（15 条）**：

| action | 说明 |
|---|---|
| create | 创建 skill |
| update | 全量更新 |
| patch | 局部更新 |
| delete | 删除 |
| get | 单查 |
| list | 分页列表 |
| search | 检索 |
| versions | 版本列表 |
| files/write | 写文件 |
| files/remove | 删文件 |
| files/read | 读文件 |
| listing | 目录列举 |
| extract | 抽取 |
| export | 导出 |
| conversation/add | 对话追加（skill 抽取主链路，2026-08 新增进白名单） |

**错误**：未知 action 返回 `404 UNKNOWN_SKILL_ACTION`。

**示例**（`list`）：

```json
// 请求
POST /api/v1/skill/list
{
  "user_id": "u_1",
  "team_id": "t_1",
  "filters": { "status": ["active"] },
  "pagination": { "limit": 50, "offset": 0 }
}

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "skill_id": "skl_1", "name": "code-review", "owner_agent_id": "agt_1" } ],
    "total": 1
  }
}
```

---

## 3.4 Chat-Memory

> 记忆块（MemoryBlock）出参统一结构：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 资产 ID（`chat_memory-{team}-{agent}` 或自建 `mem-xxx`） |
| title | string | 块标题 |
| summary | string | 摘要（当前为占位文本） |
| uploaded_by_user_id | string | owner 用户 ID |
| updated_at_ms | number | 更新时间（ms epoch） |
| layer_counts | object | `{ L0_messages, L1, L2, L3 }`（当前为占位全 0） |
| scope | string | `team` / `private` |
| agent_id | string | 关联 agent（部分接口返回） |

### POST /chat-memory/team-assets

团队已共享的记忆资产列表（`visibility=team`，不区分 owner）。**注意：此接口返回的 MemoryBlock 不含 `scope` 字段**（团队资产 tab 语义上均为已共享）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | MemoryBlock[] | 团队共享记忆块（不含 `scope`） |
| total | number | 总数 |

**示例**

```json
// 请求
{ "team_id": "t_1" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "id": "chat_memory-t_1-agt_1", "title": "发版助手", "summary": "0 条 L1 · 0 条 L2 · 0 条 L3" } ],
    "total": 1
  }
}
```

### POST /chat-memory/agent-fixed

指定 Agent 名下 `chat_memory` 类型的固定资产绑定列表。**仅 Agent owner 可见**。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| agent_id | string | 是 | Agent ID |

**响应** `data`：`{ items: MemoryBlock[], total }`，其中每条含 `scope`（`team`/`private`）供前端灰化"已被 owner 设私密"的条目。

**错误**：`MISSING_AGENT_ID`、`INVALID_USER_KEY`、`AGENT_NOT_FOUND`、`NOT_YOUR_AGENT`。

### POST /chat-memory/my-agents

"我的资产分配" tab：返回我 owner 的所有 Agent，每个 Agent 对应一块记忆（`block.id = chat_memory-{team}-{agent}`）。

**请求体**：`{ team_id: string }`

**响应** `data`：`{ items: MemoryBlock[], total }`，每条含 `agent_id`、`scope`（来自该 agent 自有记忆的 visibility）。

**错误**：`MISSING_TEAM_ID`、`INVALID_USER_KEY`。

### POST /chat-memory/mine

我（owner）名下的记忆资产列表。

**请求体**：`{ team_id: string }`

**响应** `data`：`{ items: MemoryBlock[], total }`。

**错误**：`MISSING_TEAM_ID`、`INVALID_USER_KEY`。

### POST /chat-memory/create

创建独立记忆资产（UserAsset，`mem-xxx`）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| title | string | 是 | 标题，≤ 200 字符 |
| scope | string | 否 | `team`（默认）/ `private` |
| description | string | 否 | 描述 |

**响应** `data`：`MemoryBlock`（`id` 为新建 `mem-xxx`）。

**错误**：`MISSING_TEAM_ID`、`INVALID_TITLE`、`INVALID_USER_KEY`。

**示例**

```json
// 请求
{ "team_id": "t_1", "title": "产品需求笔记", "scope": "team" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "id": "mem_xxx", "title": "产品需求笔记", "scope": "team" }
}
```

### POST /chat-memory/import

导入历史对话到 Agent 记忆池的 L0（走数据面 `/v3/conversation/add`，不新建资产）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| agent_id | string | 是 | 目标 Agent |
| messages | object[] | 是 | `[{ role, content, ts? }]`，≤ 100 条 |
| session_id | string | 否 | 会话 ID，缺省自动生成 `imported-{ts}` |

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| imported | boolean | 固定 `true` |
| block_id | string | `chat_memory-{team}-{agent}` |
| session_id | string | 实际 session |
| accepted_count | number | 成功写入条数 |

**错误**：`MISSING_TEAM_ID`、`MISSING_AGENT_ID`、`MISSING_MESSAGES`、`TOO_MANY_MESSAGES`、`NO_VALID_MESSAGES`、`AGENT_NOT_FOUND`、`AGENT_NOT_IN_TEAM`、`NOT_YOUR_AGENT`。

**示例**

```json
// 请求
{
  "team_id": "t_1",
  "agent_id": "agt_1",
  "messages": [ { "role": "user", "content": "帮我看看这个 bug" } ]
}

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "imported": true, "block_id": "chat_memory-t_1-agt_1", "accepted_count": 1 }
}
```

### POST /chat-memory/patch-scope

修改记忆可见性（team ↔ private）。

**请求体**：`{ block_id: string, scope: "team" | "private" }`

**响应** `data`：`{ updated: true, id, scope }`。

**错误**：`MISSING_BLOCK_ID`、`INVALID_SCOPE`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`。

### POST /chat-memory/set-agent-fixed

批量设置 Agent 的固定记忆（原子校验 + 单次全量 set）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| agent_id | string | 是 | 目标 Agent |
| team_id | string | 是 | 团队 ID |
| block_ids | string[] | 是 | 要绑定的记忆块 ID（含自身 `chat_memory-{team}-{agent}`） |

**响应** `data`：`{ updated: true, agent_id, block_ids }`。

**错误**：`MISSING_AGENT_ID`、`MISSING_TEAM_ID`、`IMPORT_LIMIT_EXCEEDED`、`AGENT_NOT_FOUND`、`AGENT_NOT_IN_TEAM`、`NOT_YOUR_AGENT`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`、`TEAM_MISMATCH`、`ASSET_NOT_SHARED`。

### POST /chat-memory/allocate

把一块共享记忆分配（借入）到指定 Agent。含"借入 ≤ 2 条"校验。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| block_id | string | 是 | 记忆块 ID |
| agent_id | string | 是 | 目标 Agent |
| team_id | string | 是 | 团队 ID |

**响应** `data`：`{ allocated: true, agent_id, block_id }`。

**错误**：`MISSING_BLOCK_ID`、`MISSING_AGENT_ID`、`MISSING_TEAM_ID`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`、`TEAM_MISMATCH`、`AGENT_NOT_FOUND`、`AGENT_NOT_IN_TEAM`、`NOT_YOUR_AGENT`、`ASSET_NOT_SHARED`、`IMPORT_LIMIT_EXCEEDED`；重复分配返回 `409` 中文提示；把 agent 自己的 `chat_memory-{team}-{agent}` 再分配给自己返回 `400` 中文提示（"不能把该 Agent 自己的记忆再分配给自己"）。

**示例**

```json
// 请求
{ "block_id": "chat_memory-t_1-agt_2", "agent_id": "agt_1", "team_id": "t_1" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "allocated": true, "agent_id": "agt_1", "block_id": "chat_memory-t_1-agt_2" }
}
```

### POST /chat-memory/unbind

从 Agent 解绑借入的记忆。

**请求体**：`{ block_id: string, agent_id: string, team_id: string }`

**响应** `data`：`{ unbound: true, agent_id, block_id }`。

**错误**：`MISSING_BLOCK_ID`、`MISSING_AGENT_ID`、`MISSING_TEAM_ID`、`CANNOT_UNBIND_SELF_CHAT_MEMORY`、`AGENT_NOT_FOUND`、`AGENT_NOT_IN_TEAM`、`NOT_YOUR_AGENT`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`、`BINDING_NOT_FOUND`。

### POST /chat-memory/layer

分层懒加载记忆内容。从 `block_id` 反解 team/agent 后调内核数据面。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| block_id | string | 是 | 记忆块 ID |
| layer | string | 是 | `L0` / `L1` / `L2` / `L3` |
| limit | number | 否 | 合法值 `(0, 200]`；不传、传 ≤0 或 >200 时回退 50（非 clamp，与 task/search 的 clamp 语义不同） |
| offset | number | 否 | 默认 0 |
| before_ts | string | 否 | L0 游标分页（ISO8601，翻页传上页最后一条时间） |
| time_start | string | 否 | 时间筛选起始（仅 L0/L1） |
| time_end | string | 否 | 时间筛选结束（仅 L0/L1） |
| path | string | 否 | L2 单条读取时指定文件路径 |

**各层数据源**：L0 → `/v3/conversation/query`；L1 → `/v3/atomic/query`；L2 → `/v3/scenario/ls`（列表）/ `/v3/scenario/read`（带 `path`）；L3 → `/v3/core/read`。

**响应** `data`：`{ layer, items, total, limit, offset }`，`items` 每项结构：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 条目 ID（L3 固定 `"core"`） |
| title | string | 标题（L0 为 role@session，L1 为类型，L2 为路径，L3 固定 `"core memory"`） |
| role | string? | 仅 L0 有：消息角色（`user`/`assistant`/`tool` 等） |
| body | string | 内容 |
| tags | string[] | 标签 |
| refs | string[] | 引用（当前恒空） |
| created_at | string | 时间（ISO） |

**读权限**：owner / `visibility=team` / 已被 caller 名下 agent 借入，任一即可；否则 `403 ASSET_NOT_ACCESSIBLE`。

**错误**：`MISSING_BLOCK_ID`、`INVALID_LAYER`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`、`ASSET_NOT_ACCESSIBLE`、`RANGE_TOO_LARGE`（时间筛选范围过大，VDB 无法支撑）、`LAYER_FETCH_ERROR`。

**示例**（L1）

```json
// 请求
{ "block_id": "chat_memory-t_1-agt_1", "layer": "L1", "limit": 20, "offset": 0 }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "layer": "L1",
    "items": [ { "id": "rec_1", "title": "atomic", "body": "下周一发版", "tags": [], "refs": [] } ],
    "total": 1,
    "limit": 20,
    "offset": 0
  }
}
```

### POST /chat-memory/clear

一键清空若干记忆的全部内容，保留资产本身（归属/绑定/ACL 不变）。**仅资产 Owner**。

**请求体**：`{ memory_ids: string[] }`（去重后 ≤ 100 条）。

**响应**：透传内核 `/v3/chat-memory/clear` 结果。

**错误**：`MISSING_MEMORY_IDS`、`TOO_MANY_MEMORY_IDS`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`、`NOT_ASSET_OWNER`、`CLEAR_FAILED`。

### POST /chat-memory/layer-delete

L0/L1 列表批量删除。**仅资产 Owner**。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| block_id | string | 是 | 记忆块 ID |
| layer | string | 是 | `L0` / `L1` |
| message_ids | string[] | L0 用 | 消息 ID，≤ 5000 |
| session_ids | string[] | L0 用 | 会话 ID，≤ 100 |
| ids | string[] | L1 用 | 记录 ID，≤ 5000 |

**响应**：透传内核 `/v3/conversation/delete` 或 `/v3/atomic/delete` 结果（含 `deleted_count`）。

**错误**：`MISSING_BLOCK_ID`、`INVALID_LAYER`、`NOT_AGENT_MEMORY`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`、`NOT_ASSET_OWNER`、`TOO_MANY_IDS`、`MISSING_IDS`、`LAYER_DELETE_FAILED`。

### POST /chat-memory/layer-update

编辑单层记忆内容。**仅资产 Owner**。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| block_id | string | 是 | 记忆块 ID |
| layer | string | 是 | `L1` / `L2` / `L3` |
| id | string | L1/L2 必填 | L1 记录主键 / L2 文件路径 |
| content | string | 是 | 新内容 |
| summary | string | 否 | L2 摘要 |

**各层数据源**：L1 → `/v3/atomic/update`；L2 → `/v3/scenario/write`（自动剥 META 头）；L3 → `/v3/core/write`。

**响应**：透传内核对应 write 接口结果。

**错误**：`MISSING_BLOCK_ID`、`INVALID_LAYER`、`MISSING_CONTENT`、`MISSING_ITEM_ID`、`NOT_AGENT_MEMORY`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`、`NOT_ASSET_OWNER`、`LAYER_UPDATE_FAILED`。

### POST /chat-memory/search

分层关键词检索（agent 维度跨 session 召回）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| block_id | string | 是 | 记忆块 ID |
| layer | string | 否 | `L0` / `L1`，默认 `L1` |
| query | string | 是 | 检索词 |
| limit | number | 否 | 默认 30，上限 100 |
| type | string | 否 | L1 类型过滤 |

**响应** `data`：`{ items, total }`，`items` 每项含 `score`（相关度）；L1 的 `id` 可直接用于 `layer-update`。

**错误**：`MISSING_BLOCK_ID`、`MISSING_QUERY`、`BLOCK_NOT_FOUND`、`NOT_CHAT_MEMORY`、`ASSET_NOT_ACCESSIBLE`、`SEARCH_FAILED`。

**示例**

```json
// 请求
{ "block_id": "chat_memory-t_1-agt_1", "layer": "L1", "query": "发版" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "id": "rec_1", "title": "atomic", "body": "下周一发版", "score": 0.92 } ],
    "total": 1
  }
}
```

---

## 3.5 Task

### POST /task/list-with-agents

聚合 `task/list` + 批量 `task-agent/list`，一次返回 task 及其关联 agents，消除前端 N+1（否则需 2N+1 次请求）。

**上游**：`meta/task/list`、`meta/task-agent/list`。

**请求体**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| team_id | string | 是 | — | 团队 ID |
| limit | number | 否 | — | 单页数量，上限 200。**注意**：不传 `limit` 时响应 `limit` 字段回显 50，但内核 `task/list` 实际按默认 20 条返回 |
| offset | number | 否 | 0 | 偏移 |
| status | string | 否 | — | 按状态过滤 |
| title | string | 否 | — | 标题过滤 |

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| items | TaskWithAgents[] | task 列表，每条含 `agents` 子数组 |
| total | number | 总数 |
| limit | number | 本次实际 limit |
| offset | number | 本次实际 offset |

**TaskWithAgents**：task 字段（`task_id`、`team_id`、`title`、`description?`、`status`、`source_type?`、`risk_level?`、`created_at`、`updated_at`）+ `agents: TaskAgent[]`（`agent_id`、`task_id`、`team_id`、`status`、`created_at`）。

**错误**：`MISSING_TEAM_ID`。

**示例**

```json
// 请求
{ "team_id": "t_1", "limit": 10 }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [
      { "task_id": "tsk_1", "title": "灰度验证", "status": "active", "agents": [ { "agent_id": "agt_1" } ] }
    ],
    "total": 1,
    "limit": 10,
    "offset": 0
  }
}
```

---

## 3.6 Agent 概览

### POST /agent-overview/bootstrap

聚合返回 Agent 概览页所需的全部资产引导数据（skill / code-graph / wiki / chat-memory 资产池 + 各 agent 挂载计数）。

**上游**：`meta/asset/list-accessible`（4 类资产）、`meta/agent/list`、`skill/list`、`meta/agent-fixed-asset/summary-by-agents`。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| agent_ids | string[] | 否 | 限定统计的 agent；缺省为 team 下全部 active agent |

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| assets.skills | Mountable[] | 团队共享 skill 资产 |
| assets.codeGraphs | Mountable[] | 团队 code-graph 资产 |
| assets.wikis | Mountable[] | 团队 wiki 资产 |
| assets.chatMemories | Mountable[] | 团队共享记忆资产 |
| counts | object | `{ [agent_id]: { skills, code_graph, llm_wiki, chat_memory } }`（挂载计数） |

> `Mountable`：`{ key, title, group, slug, status }`。`counts` 标记为 `@deprecated`，内部已改用 `summary-by-agents`。

**错误**：`MISSING_TEAM_ID`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`。

**示例**

```json
// 请求
{ "team_id": "t_1" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "assets": { "skills": [], "codeGraphs": [], "wikis": [], "chatMemories": [] },
    "counts": { "agt_1": { "skills": 2, "code_graph": 1, "llm_wiki": 0, "chat_memory": 1 } }
  }
}
```

---

## 3.7 Agent 生命周期

### POST /agent/delete-cascade

删除 Agent：先级联删除其名下所有 active skill，再调内核 `agent/archive`（archive 内部会顺手清 chat_memory）。

**上游**：`skill/list`、`skill/delete`、`meta/agent/archive`。

**请求体**：`{ agent_id: string }`

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| archived | boolean | 固定 `true` |
| agent_id | string | 被归档的 agent |
| deleted_skill_count | number | 已删 skill 数 |
| deleted_skill_ids | string[] | 已删 skill ID 列表 |

**错误**：`MISSING_AGENT_ID`、`INVALID_USER_KEY`、`AGENT_NOT_FOUND`、`NOT_YOUR_AGENT`；任一 skill 删除失败返回 `500 SKILL_DELETE_FAILED`（含 `failed_skill_id`、`deleted_skill_ids`），此时 agent 不会 archive。

**示例**

```json
// 请求
{ "agent_id": "agt_1" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "archived": true, "agent_id": "agt_1", "deleted_skill_count": 2, "deleted_skill_ids": ["skl_1", "skl_2"] }
}
```

---

## 3.8 Knowledge - Wiki

> 门控约定：带 `team_id` 的端点（list/create/raw/write）要求 team 成员；id-only 端点（get/ingest/delete/graph/page/search/raw/ls 等）要求有效 caller + 读/写权限（`requireKnowledgeRead`）。
> 统一透传 KS（知识服务）`/v3/wiki/*`，信封由 Panel 组装。

### POST /knowledge/wiki/list

**@deprecated**（面板 UI 已改用 `team-assets`/`my-assets`）。

**请求体**：`{ team_id: string, status?: string, limit?: number, offset?: number }`

**错误**：`MISSING_TEAM_ID`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`。

### POST /knowledge/wiki/create

创建 Wiki 知识库，并幂等登记 meta_asset（`asset_id = wiki_id`）。

**请求体**：`{ team_id: string, name: string }`

**响应** `data`：KS wiki 详情（含 `wiki_id`、`service_url` 等）。

**错误**：`MISSING_TEAM_ID`、`MISSING_NAME`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`。

**示例**

```json
// 请求
{ "team_id": "t_1", "name": "团队 wiki" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "wiki_id": "wiki_1", "name": "团队 wiki", "status": "processing" }
}
```

### POST /knowledge/wiki/ingest

触发 Wiki 抽取（需 write 权限，空 wiki 拒绝）。

**请求体**：`{ wiki_id: string }`

**错误**：`MISSING_WIKI_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`、`WIKI_EMPTY_NO_SOURCES`。

### POST /knowledge/wiki/get

查询 Wiki 详情（聚合 Panel 内存 ingest 进度到 `progress` 字段）。

**请求体**：`{ wiki_id: string }`

**响应** `data`：KS wiki 详情 + `progress`（ingest 进度）。

**错误**：`MISSING_WIKI_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/wiki/delete

删除 Wiki（三处：KS + 内核明细 + meta_asset 级联）。

**请求体**：`{ wiki_ids: string[] }`

**响应** `data`：KS delete 结果。

**错误**：`MISSING_WIKI_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/wiki/graph

查询 Wiki 知识图谱。

**请求体**：`{ wiki_id: string }`

**错误**：`MISSING_WIKI_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/wiki/page/ls

列出 Wiki 页面。

**请求体**：`{ wiki_id: string }`

**错误**：`MISSING_WIKI_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/wiki/page/read

读取指定页面。

**请求体**：`{ wiki_id: string, refs: string[] }`

**错误**：`MISSING_WIKI_ID`、`MISSING_REFS`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

**示例**

```json
// 请求
{ "wiki_id": "wiki_1", "refs": ["page/首页"] }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "pages": [ { "ref": "page/首页", "content": "..." } ] }
}
```

### POST /knowledge/wiki/page/rm

删除页面（需 write 权限）。

**请求体**：`{ wiki_id: string, refs: string[] }`

**错误**：`MISSING_WIKI_ID`、`MISSING_REFS`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`、`MISSING_TEAM_ID`。

### POST /knowledge/wiki/search

检索 Wiki。

**请求体**：`{ wiki_id: string, query: string, limit?: number }`

**错误**：`MISSING_WIKI_ID`、`MISSING_QUERY`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/wiki/raw/ls

列出原始源文件。

**请求体**：`{ wiki_id: string }`

**错误**：`MISSING_WIKI_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/wiki/raw/read

读取原始源文件内容。

**请求体**：`{ wiki_id: string, filenames: string[] }`

**错误**：`MISSING_WIKI_ID`、`MISSING_FILENAMES`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/wiki/raw/rm

删除原始源文件（需 write 权限）。

**请求体**：`{ wiki_id: string, filenames: string[] }`

**错误**：`MISSING_WIKI_ID`、`MISSING_FILENAMES`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`、`MISSING_TEAM_ID`。

### POST /knowledge/wiki/raw/write

上传源文件（team 门控 + 大小限制）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| wiki_id | string | 是 | Wiki ID |
| files | object[] | 是 | `[{ path, content, ... }]`，单文件 ≤ 512KB，单次 ≤ 10 个，总 ≤ 5MB |

**错误**：`MISSING_TEAM_ID`、`MISSING_WIKI_ID`、`MISSING_FILES`、`TOO_MANY_FILES`、`FILE_TOO_LARGE`、`TOTAL_TOO_LARGE`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`。

---

## 3.9 Knowledge - Code-Graph

### POST /knowledge/code-graph/list

**@deprecated**（面板 UI 已改用 `team-assets`/`my-assets`）。

**请求体**：`{ team_id: string, status?: string, limit?: number, offset?: number }`

**错误**：`MISSING_TEAM_ID`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`。

### POST /knowledge/code-graph/create

创建 Code-Graph（KS 创建后自动 build，meta 在 ready callback 时登记）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| repo_url | string | 是 | 仓库地址 |
| branch | string | 否 | 分支 |
| repo_name | string | 否 | 仓库名 |

**响应** `data`：KS code-graph 详情（含 `code_graph_id`）。

**错误**：`MISSING_TEAM_ID`、`MISSING_REPO_URL`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`。

**示例**

```json
// 请求
{ "team_id": "t_1", "repo_url": "https://github.com/org/repo", "branch": "main" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "code_graph_id": "cg_1", "repo_url": "https://github.com/org/repo", "status": "building" }
}
```

### POST /knowledge/code-graph/register-meta

Code-Graph ready 后由 owner 登记 meta_asset（前端兜底路径，幂等）。

**请求体**：`{ team_id: string, code_graph_id: string }`

**响应** `data`：`{ registered: true, code_graph_id }`。

**错误**：`MISSING_TEAM_ID`、`MISSING_CODE_GRAPH_ID`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`、`FORBIDDEN`、`KNOWLEDGE_NOT_FOUND`、`CODE_GRAPH_NOT_READY`、`NOT_RESOURCE_OWNER`。

### POST /knowledge/code-graph/get

查询 Code-Graph 详情（构建中无 meta 时 owner 可读）。

**请求体**：`{ code_graph_id: string }`

**错误**：`MISSING_CODE_GRAPH_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/code-graph/sync

触发 Code-Graph 同步（需 write 权限）。

**请求体**：`{ code_graph_id: string }`

**错误**：`MISSING_CODE_GRAPH_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/code-graph/delete

删除 Code-Graph（三处级联）。

**请求体**：`{ code_graph_ids: string[] }`

**错误**：`MISSING_CODE_GRAPH_ID`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

### POST /knowledge/code-graph/search

Code-Graph 代码检索。

**请求体**：`{ code_graph_id: string, query: string, kind?: string, limit?: number }`

**响应** `data`：KS 返回的 `{ text, isError }` 文本块。

**错误**：`MISSING_CODE_GRAPH_ID`、`MISSING_QUERY`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

**示例**

```json
// 请求
{ "code_graph_id": "cg_1", "query": "用户登录逻辑" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "text": "...", "isError": false }
}
```

### POST /knowledge/code-graph/explore

Code-Graph 代码探索。

**请求体**：`{ code_graph_id: string, query: string, maxFiles?: number }`

**响应** `data`：KS 返回的 `{ text, isError }` 文本块。

**错误**：`MISSING_CODE_GRAPH_ID`、`MISSING_QUERY`、`INVALID_USER_KEY`、`FORBIDDEN`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`。

---

## 3.10 Knowledge - 分配与授权

### POST /knowledge/allocate

把 knowledge 资产绑定到 Agent（`injection_mode = 'tool'`）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| knowledge_id | string | 是 | 资产 ID（wiki_id / cg_id） |
| agent_id | string | 是 | 目标 Agent |
| team_id | string | 是 | 团队 ID |

**响应** `data`：`{ allocated: true, agent_id, knowledge_id }`。

**错误**：`MISSING_KNOWLEDGE_ID`、`MISSING_AGENT_ID`、`MISSING_TEAM_ID`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`、`KNOWLEDGE_NOT_FOUND`、`NOT_KNOWLEDGE_ASSET`、`TEAM_MISMATCH`、`AGENT_NOT_FOUND`、`AGENT_NOT_IN_TEAM`、`ALREADY_ALLOCATED`。

**示例**

```json
// 请求
{ "knowledge_id": "wiki_1", "agent_id": "agt_1", "team_id": "t_1" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": { "allocated": true, "agent_id": "agt_1", "knowledge_id": "wiki_1" }
}
```

### POST /knowledge/unbind

从 Agent 解绑 knowledge 资产（仅 agent owner）。

**请求体**：`{ knowledge_id: string, agent_id: string }`

**响应** `data`：`{ unbound: true, agent_id, knowledge_id }`。

**错误**：`MISSING_KNOWLEDGE_ID`、`MISSING_AGENT_ID`、`INVALID_USER_KEY`、`AGENT_NOT_FOUND`、`NOT_YOUR_AGENT`、`BINDING_NOT_FOUND`。

### POST /knowledge/agent-fixed

列出 Agent 绑定的 wiki/code_graph 固定资产。

**请求体**：`{ agent_id: string }`

**响应** `data`：`{ items: FixedAsset[], total }`，每条含 `knowledge_id`、`asset_type`、`name`、`description`、`status`、`visibility`、`agent_id`。

**错误**：`MISSING_AGENT_ID`、`INVALID_USER_KEY`、`AGENT_NOT_FOUND`、`NOT_TEAM_MEMBER`。

### POST /knowledge/set-visibility

设置资产可见性（走 `meta/asset/update`，owner-only 由内核保证）。

**请求体**：`{ knowledge_id: string, visibility: string }`（`private`/`team`/`restricted`/`agent`/`task`）

**错误**：`MISSING_KNOWLEDGE_ID`、`INVALID_VISIBILITY`。

### POST /knowledge/grant

给资产授权（走 `meta/acl/grant`，owner-only 由内核保证）。

**请求体**：`{ knowledge_id: string, subject_type: string, subject_id: string, permission: string }`

**错误**：`MISSING_KNOWLEDGE_ID`、`MISSING_GRANT_FIELDS`。

---

## 3.11 Knowledge - 状态回调

### POST /knowledge/status-callback

KS → Panel 的 S2S 状态回调（ingest/sync 完成或进度更新）。**无鉴权**（S2S，无浏览器 header）。

**请求体**（两种形态）：

① 终态回调（`status = ready | failed`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| knowledge_id | string | 是 | 资源 ID |
| type | string | 是 | `wiki` / `code-graph` |
| status | string | 是 | `ready` / `failed` |
| summary | string | 否 | ready 时携带的摘要 |
| service_id | string | 否 | 实例 ID（用于解析内核凭证） |
| sync_error | string | 否 | failed 时的错误 |
| run_id | string | 否 | ingest 代际 |

② 进度回调（`event = ingest_progress`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| event | string | 是 | `ingest_progress` |
| wiki_id | string | 是 | Wiki ID |
| progress | object | 是 | `{ phase, total, completed, failed, skipped, percent }` |

**响应** `data`：`null`（`code=0` 固定 ack）。

**语义**：`ready` 时 Panel 会写内核明细 `entity_knowledge`（`/v3/knowledge/create`）并注册 meta_asset；`failed` 时不写。

**示例**

```json
// 请求（终态 ready）
{
  "knowledge_id": "wiki_1",
  "type": "wiki",
  "status": "ready",
  "summary": "团队 wiki 摘要",
  "service_id": "inst_1"
}

// 响应
{ "code": 0, "message": "ok", "request_id": "", "data": null }
```

---

## 3.12 Knowledge - 团队资产

### POST /knowledge/wiki/team-assets

团队 Wiki 资产池（meta `list-accessible` + KS get 补运营状态，并合并 KS 侧未注册 meta 的"创建中/失败"资源）。

**请求体**：`{ team_id: string }`

**响应** `data`：`{ items: KnowledgeAssetListItem[], total }`。

**错误**：`MISSING_TEAM_ID`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`。

**示例**

```json
// 请求
{ "team_id": "t_1" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "abc-123",
  "data": {
    "items": [ { "knowledge_id": "wiki_1", "asset_type": "llm_wiki", "name": "团队 wiki", "status": "ready" } ],
    "total": 1
  }
}
```

### POST /knowledge/code-graph/team-assets

团队 Code-Graph 资产池（结构同 `wiki/team-assets`，`asset_type = code_graph`）。

**请求体**：`{ team_id: string }`

**响应** `data`：`{ items, total }`。

**错误**：`MISSING_TEAM_ID`、`INVALID_USER_KEY`、`NOT_TEAM_MEMBER`。

---

## 4. 附录

### 4.1 废弃接口

| 接口 | 状态 | 替代 |
|---|---|---|
| `POST /knowledge/wiki/list` | @deprecated | `POST /knowledge/wiki/team-assets` |
| `POST /knowledge/code-graph/list` | @deprecated | `POST /knowledge/code-graph/team-assets` |
| `POST /agent-overview/bootstrap` 的 `counts` 字段 | @deprecated | 内部改用 `agent-fixed-asset/summary-by-agents` |

### 4.2 错误 message 枚举汇总

> `message` 是稳定契约，前端按此分支；新增错误码需同步本表。
>
> 注意三类 `message` 格式例外（均为 Panel 组装、非纯枚举）：
> 1. **数据面失败类**（`LAYER_FETCH_ERROR` / `CLEAR_FAILED` / `LAYER_DELETE_FAILED` / `LAYER_UPDATE_FAILED` / `SEARCH_FAILED`）：实际值为 `"<CODE>: <err.message>"`（带 `: 详情` 后缀），前端应 `startsWith(CODE)` 而非精确等值匹配。
> 2. **`POST /knowledge/status-callback` 的 400**：`message` 是小写英文句子（`"wiki_id and progress fields are required"` / `"knowledge_id, type, status are required"`），非枚举。该接口是 S2S 回调，前端不直接消费，可忽略。
> 3. **中文句子类**（`respondControlError` 直接塞中文，非枚举，`startsWith(CODE)` 也匹配不到）：`meta/*` create 查重 409（"已存在同名…请更换名称后重试"）、`chat-memory/allocate` 重复分配 409（"这条记忆已经分配给该 Agent"）、自己分配自己 400（"不能把该 Agent 自己的记忆再分配给自己"）。前端需按 message 文案或 HTTP 状态兜底，不能按 CODE 枚举分支。

**通用（Header / 鉴权 / 框架）**

| HTTP | message | 说明 |
|---|---|---|
| 400 | MISSING_INSTANCE_ID | 缺 `x-tdai-service-id` |
| 400 | INVALID_INSTANCE | 实例不存在/无效 |
| 400 | MISSING_USER_KEY | 缺 `x-tdai-user-key` |
| 401 | INVALID_USER_KEY | user_key 无效（auth/verify 失败） |
| 403 | NOT_TEAM_MEMBER | 非团队成员 |
| 403 | FORBIDDEN | 无资源访问权限 |
| 404 | KNOWLEDGE_NOT_FOUND | 知识资源不存在 |
| 500 | INTERNAL | 未捕获异常 |
| 502 | UPSTREAM_ERROR | 上游 KS 错误 |

**Meta / Skill 代理**

| HTTP | message | 说明 |
|---|---|---|
| 404 | UNKNOWN_META_ACTION | 未知 meta action |
| 404 | UNKNOWN_SKILL_ACTION | 未知 skill action |
| 501 | NOT_IN_SCOPE | action 未对面板开放（agent-fixed-asset/*） |
| 403 | permission_denied | 非 system_admin 操作默认模板 |
| 400 | INVALID_PARAM | `agent/set-default-template` 缺 `team_id`/`template` |

**Chat-Memory**

| HTTP | message | 说明 |
|---|---|---|
| 400 | MISSING_TEAM_ID / MISSING_AGENT_ID / MISSING_BLOCK_ID / MISSING_QUERY | 缺必填字段 |
| 400 | INVALID_TITLE / INVALID_SCOPE / INVALID_LAYER | 参数非法 |
| 400 | MISSING_MESSAGES / TOO_MANY_MESSAGES / NO_VALID_MESSAGES | 导入消息非法 |
| 400 | MISSING_MEMORY_IDS / TOO_MANY_MEMORY_IDS | clear 参数非法 |
| 400 | MISSING_IDS / TOO_MANY_IDS | 批量删除参数非法 |
| 400 | MISSING_CONTENT / MISSING_ITEM_ID | layer-update 参数非法 |
| 400 | NOT_CHAT_MEMORY / NOT_AGENT_MEMORY / TEAM_MISMATCH / AGENT_NOT_IN_TEAM | 资源类型/归属不符 |
| 400 | CANNOT_UNBIND_SELF_CHAT_MEMORY / IMPORT_LIMIT_EXCEEDED | 业务规则拦截 |
| 400 | RANGE_TOO_LARGE | 时间筛选范围过大（VDB 无法支撑） |
| 403 | NOT_YOUR_AGENT / NOT_ASSET_OWNER / ASSET_NOT_SHARED / ASSET_NOT_ACCESSIBLE | 权限拒绝 |
| 404 | BLOCK_NOT_FOUND / AGENT_NOT_FOUND / BINDING_NOT_FOUND | 资源不存在 |
| 500 | LAYER_FETCH_ERROR / CLEAR_FAILED / LAYER_DELETE_FAILED / LAYER_UPDATE_FAILED / SEARCH_FAILED | 数据面异常 |

**Knowledge**

| HTTP | message | 说明 |
|---|---|---|
| 400 | MISSING_NAME / MISSING_WIKI_ID / MISSING_REFS / MISSING_FILENAMES / MISSING_FILES | 缺必填字段 |
| 400 | MISSING_CODE_GRAPH_ID / MISSING_REPO_URL / MISSING_QUERY | 缺必填字段 |
| 400 | MISSING_KNOWLEDGE_ID / MISSING_AGENT_ID / MISSING_GRANT_FIELDS | 缺必填字段 |
| 400 | NOT_KNOWLEDGE_ASSET / TEAM_MISMATCH / AGENT_NOT_IN_TEAM / INVALID_VISIBILITY | 资源类型/归属非法 |
| 400 | WIKI_EMPTY_NO_SOURCES | 空 wiki 禁止 ingest |
| 403 | NOT_RESOURCE_OWNER / NOT_YOUR_AGENT | 权限拒绝 |
| 409 | ALREADY_ALLOCATED / CODE_GRAPH_NOT_READY | 状态冲突 |
| 404 | AGENT_NOT_FOUND / BINDING_NOT_FOUND | 资源不存在 |
| 413 | TOO_MANY_FILES / FILE_TOO_LARGE / TOTAL_TOO_LARGE | 上传超限 |

**Agent / Task**

| HTTP | message | 说明 |
|---|---|---|
| 400 | MISSING_AGENT_ID / MISSING_TEAM_ID | 缺必填字段 |
| 403 | NOT_YOUR_AGENT | 非 agent owner |
| 404 | AGENT_NOT_FOUND | agent 不存在 |
| 500 | SKILL_DELETE_FAILED | 级联删除 skill 失败 |
