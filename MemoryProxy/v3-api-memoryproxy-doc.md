# v3 接口文档 · 卷三 MemoryProxy

> 服务：MemoryProxy（LLM 反代 + 注入代理），端口 `8096`
> 本卷覆盖 MemoryProxy 暴露的全部 `/v3/*` 接口（**共 6 个**，均为 ops/管理类）。MemoryCore 见卷一，MemoryKnowledge 见卷二。
> 维护约定：接口变更须在同一 PR 内更新本文档。

---

## 1. 公共约定

### 1.1 服务与端口

| 项 | 值 |
|---|---|
| 服务 | MemoryProxy |
| 端口 | 8096 |
| 本卷前缀 | `/v3`（仅限 ops 管理面；**LLM 主链路是 `/v1/messages`、`/:agent/:spaceId/v1/*` 等，不属 v3 文档范围**） |
| 健康检查 | `GET /health`（非 v3，返回裸 JSON，含 status/version/upstream/storage 等） |
| `GET /whoami` | 非 v3，API key → key ID（纯文本） |

### 1.2 信封（**不统一，分两类**）

MemoryProxy 的 v3 接口信封分两类，**与卷一 MemoryCore、卷二 MemoryKnowledge 都不同**：

| 接口组 | 信封 | 说明 |
|---|---|---|
| `instance/proxy-destroy`、`admin/rate-limits`（3 方法） | `{ code, message, data }` | **无 `request_id`**（同卷二 KS 风格） |
| `session/refresh-cache`、`session/force-archive-skill` | `{ code, message, request_id, data }` | 有 `request_id`，值为 `refresh-${Date.now()}` / `force-archive-${Date.now()}` |

成功统一 `code=0, message="ok"`。

### 1.3 鉴权（**仅 1 个接口有鉴权**）

| 接口 | 鉴权 |
|---|---|
| `POST /v3/instance/proxy-destroy` | `Authorization: Bearer <admin.apiKey>`；`admin.apiKey` **未配置时公开**（`checkAdminAuth` 空 key 直接放行）。使用 `timingSafeEqual` 常量时间比较 |
| `admin/rate-limits`（GET/PUT/DELETE） | **无鉴权** |
| `session/refresh-cache`、`session/force-archive-skill` | **无鉴权** |

> ⚠️ 实现与注释不一致：`session-refresh.ts` / `session-force-archive.ts` 头部注释写"走 admin auth 鉴权（复用 admin-auth.ts 的模式）"，但 **handler 内实际未调用 `checkAdminAuth`**，当前是无鉴权状态。文档按代码实际行为记录，前端/运维若依赖鉴权需另行加固。

### 1.4 错误 code 特征（**分两组**）

| 接口组 | 失败 code | HTTP 状态 |
|---|---|---|
| `proxy-destroy`、`rate-limits` | 标准 3 位（400/401/503） | = code |
| `session/*` | **5 位数字**（40001/40401/50001） | 3 位（400/404/500），**code ≠ HTTP** |

> `session/*` 失败时 `code` 是 5 位数字、`message` 是纯文本，但 HTTP 状态码是标准 3 位（`status = error.includes("not found") ? 404 : 400/500`）。前端需注意这里的 code 与 HTTP 解耦。

### 1.5 身份与鉴权 header

本卷 ops 接口**不校验** `x-tdai-service-id` / `x-tdai-user-key`（与卷一数据面不同），仅 `proxy-destroy` 认 Bearer。

---

## 2. 接口目录

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v3/instance/proxy-destroy` | 运维：清理 proxy 侧实例缓存 + STS pool（唯一有鉴权） |
| GET | `/v3/admin/rate-limits` | 查频控配置（全局 / 维度 override） |
| PUT | `/v3/admin/rate-limits` | 设频控配置（全局 / 维度 override） |
| DELETE | `/v3/admin/rate-limits` | 删频控配置（恢复默认 / 删 override） |
| POST | `/v3/session/refresh-cache` | 刷新 session 注入缓存（重拉 agent/task detail + prewarm） |
| POST | `/v3/session/force-archive-skill` | 手动强制归档 session skill buffer |

**合计 6 个接口（4 个路由，其中 rate-limits 占 3 个 HTTP 方法）。**

---

## 3. 接口明细

## 3.1 实例销毁

### POST /v3/instance/proxy-destroy

清理 proxy 侧某实例（spaceId）的缓存数据 + kernel-sts pool 里的 STS backend。契约字段名对齐 Core 的 `/v3/instance/destroy`，路径用 `proxy-destroy` 动作区分。

**鉴权**：`Authorization: Bearer <admin.apiKey>`（未配置则公开）。

**请求体**：`{ instance_id: string }`（非空 + 不含 `/` + 不含 `..`，复用 `assertKeySegment` 校验）。

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| instance_id | string | 回显 |
| cleaned.storage_backend | string | `cos` / `sqlite` / `fs` / `memory` |
| cleaned.storage_ttl_deleted | number | 删除 `ttl/<id>/` 前缀条数；缺省 0 |
| cleaned.storage_nottl_deleted | number | 删除 `nottl/<id>/` 前缀条数 |
| cleaned.cos_pool_evicted | string | `evicted` / `not-cached` / `unsupported` / `error` |
| cleaned.redis_skipped | string | 固定 `per-session-ttl-only` |

**局部失败策略**：某步失败不阻断整体，`cleaned` 内含对应 `storage_ttl_error` / `storage_nottl_error` / `cos_pool_error` 字段（HTTP 仍 200）。

**错误**：`400`（JSON 非法 / 缺 instance_id / 非法字符）、`401`（auth 开启且 Bearer 缺失或不匹配）。

> Redis session store（`cg:sess:*`）**不清理**：sessionKey 来自 `x-conversation-id` / `x-claude-code-session-id`，不含 spaceId，无法按 space SCAN；默认 TTL 1800s 自然过期。

**示例**

```json
// 请求
POST /v3/instance/proxy-destroy
Authorization: Bearer <admin.apiKey>
{ "instance_id": "mem-example001" }

// 响应
{
  "code": 0,
  "message": "ok",
  "data": {
    "instance_id": "mem-example001",
    "cleaned": {
      "storage_backend": "cos",
      "storage_ttl_deleted": 3,
      "storage_nottl_deleted": 5,
      "cos_pool_evicted": "evicted",
      "redis_skipped": "per-session-ttl-only"
    }
  }
}
```

---

## 3.2 频控配置（3 方法，均无鉴权）

> 频控分两层：**全局**（`config.rateLimit`）与**维度 override**（`instance_id + model_id`）。维度 override 优先于全局。

### GET /v3/admin/rate-limits

查询频控配置。

**Query**：`instance_id` + `model_id`（**必须成对出现**）。

**响应** `data`：

- 不带参数（查全局）：`{ enabled, tpm, qpm, window_seconds: 60, overrides: [...] }`
- 带 instance_id+model_id（查维度）：`{ enabled, instance_id, model_id, input_tpm, qpm, source: "global"|"override", global }`

**错误**：`400`（只传 instance_id 或 model_id 之一）、`503`（store 错误）。

### PUT /v3/admin/rate-limits

设置频控配置。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| input_tpm | number | 是 | 输入 token/分钟，**正整数** |
| qpm | number | 是 | 请求/分钟，**正整数** |
| instance_id | string | 否 | 与 model_id 成对 |
| model_id | string | 否 | 与 instance_id 成对（≤256，不含控制字符） |

**响应** `data`：不带维度返回 `{ tpm, qpm }`；带维度返回 `{ instance_id, model_id, input_tpm, qpm }`。

**错误**：`400`（JSON 非法 / 非正整数 / 维度只传一个 / model_id 非法）、`503`。

**示例**

```json
// 请求（设全局）
PUT /v3/admin/rate-limits
{ "input_tpm": 100000, "qpm": 300 }

// 响应
{ "code": 0, "message": "ok", "data": { "tpm": 100000, "qpm": 300 } }
```

### DELETE /v3/admin/rate-limits

删除频控配置（恢复默认）。

**请求体**：可选 `instance_id` + `model_id`（成对）。

**响应** `data`：不带维度返回 `{ tpm, qpm }`（回退到 config 默认值）；带维度返回 `{ instance_id, model_id, deleted: true }`。

**错误**：`400`、`503`。

---

## 3.3 Session 管理（2，均无鉴权）

> 两个接口既是 `mem:` 命令的底层实现（函数调用），也以 HTTP 形式暴露给面板前端复用。

### POST /v3/session/refresh-cache

刷新当前 session 的全部注入缓存：重拉 Agent/Task detail 覆写到 SessionStore → 用 `clearBefore=true` 重跑 `prewarmFromConfig`（清掉已解绑资产的老快照）。

**请求体**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| session_key | string | 是 | — | session 键 |
| agent_source | string | 否 | `claude-code` | 代理来源，拼 `compositeKey = ${agentSource}:${sessionKey}` |
| user_key | string | 否 | — | 传给 MetadataClient 的 caller key |
| space_id | string | 否 | — | 兜底 spaceId |

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| refreshed | string[] | 刷新成功的 hookId 列表 |
| skipped | string[] | 跳过的 hookId 列表 |
| agent_refreshed | boolean | 是否成功重拉 agent detail |
| task_refreshed | boolean | 是否成功重拉 task detail |
| took_ms | number | 耗时 |

**错误**：`40001`（JSON 非法 / 缺 session_key / `Session not initialized` / 其他参数错误）、`40401`（session not found）。失败 message 为纯文本（`session_key is required`、`Session not initialized: xxx`、`Session not found: xxx`）。

**示例**

```json
// 请求
POST /v3/session/refresh-cache
{ "session_key": "sess_1", "agent_source": "claude-code", "space_id": "mem-example001" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "refresh-1724112000000",
  "data": {
    "refreshed": ["memory", "knowledge"],
    "skipped": ["skill"],
    "agent_refreshed": true,
    "task_refreshed": false,
    "took_ms": 120
  }
}
```

### POST /v3/session/force-archive-skill

手动强制归档当前 session 的 skill buffer（跳过阈值判定的第三个触发条件）。

**请求体**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| session_key | string | 是 | — | session 键 |
| agent_source | string | 否 | `claude-code` | 代理来源 |
| reason | string | 否 | — | 归档原因（透传 Core） |
| space_id | string | 否 | — | 兜底 spaceId |

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| status | string | `archived` / `empty` |
| task_id | string? | 归档任务 ID（仅 archived） |
| archive_key | string? | 归档键 |
| archived_at_ms | number? | 归档时间（ms） |

**错误**：`40001`（JSON 非法 / 缺 session_key）、`40401`（session not found）、`50001`（调 Core `forceArchive` 失败）。

**示例**

```json
// 请求
POST /v3/session/force-archive-skill
{ "session_key": "sess_1", "reason": "manual" }

// 响应
{
  "code": 0,
  "message": "ok",
  "request_id": "force-archive-1724112000000",
  "data": { "status": "archived", "task_id": "skl_1", "archive_key": "archive/xxx", "archived_at_ms": 1724112000000 }
}
```

---

## 4. 附录

### 4.1 三卷跨服务差异总览

| 维度 | MemoryCore（卷一） | MemoryKnowledge（卷二） | MemoryProxy（本卷） |
|---|---|---|---|
| 端口 | 8420 | 8421 | 8096 |
| 信封 | `{ code, message, request_id, data }` | `{ code, message, data }` | **两种混用**（见 §1.2） |
| 鉴权 | Bearer + service-id + user-key 分层 | 仅 `x-tdai-service-id` | 仅 proxy-destroy 认 Bearer，其余无鉴权 |
| 方法 | 全 POST | 除 auto-sync status 外全 POST | **含 GET/PUT/DELETE**（rate-limits） |
| 失败 code | 三类（枚举 / 5 位 / CODE:detail） | 3 位标准 | proxy-destroy/rate-limits 3 位；session/* 5 位 |

### 4.2 已知实现偏差（文档按代码实际记录）

| 文件 | 注释声称 | 实际实现 |
|---|---|---|
| `session-refresh.ts` | "走 admin auth 鉴权" | 未调用 `checkAdminAuth`，无鉴权 |
| `session-force-archive.ts` | 同上（注释未明说，但同族） | 无鉴权 |
| `admin/rate-limits` | — | 无鉴权（若需保护建议加固） |

### 4.3 与 LLM 主链路的边界

本卷仅覆盖 `/v3/*` ops 接口。MemoryProxy 的核心是 **LLM 反代**（`/v1/messages`、`/v1/chat/completions`、`/:agent/:spaceId/v1/*`、`/codex·workbuddy·dsh/:spaceId/*` 等）与 **bridge**（`/skill-bridge/*`、`/memory-bridge/*`），这些**不属于 v3 接口文档范围**，若需文档化应单独成册。
