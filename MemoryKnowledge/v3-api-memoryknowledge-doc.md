# v3 接口文档 · 卷二 MemoryKnowledge

> 服务：MemoryKnowledge（知识服务，KS），端口 `8421`
> 本卷覆盖 MemoryKnowledge 暴露的全部 `/v3/*` 接口。MemoryCore 见卷一，MemoryProxy 见卷三。
> 维护约定：接口变更须在同一 PR 内更新本文档。

---

## 1. 公共约定

### 1.1 服务与端口

| 项 | 值 |
|---|---|
| 服务 | MemoryKnowledge（知识服务，KS） |
| 端口 | 8421（`PORT`，默认 `8421`） |
| API 前缀 | `/v3`（`API_PREFIX`，默认 `/v3`） |
| 方法 | 除 `GET /v3/auto-sync/status`、`GET /health` 外，**其余全部 `POST`** |
| Content-Type | `application/json` |
| 健康检查 | `GET /health`（**非 v3**，返回裸 JSON `{ status, timestamp }`） |
| Swagger | `GET /docs`（UI）、`GET /openapi.json`（spec，非 v3） |

### 1.2 响应信封

**注意：与 MemoryCore 不同，KS 的信封没有 `request_id` 字段。**

```json
{ "code": 0, "message": "ok", "data": { } }
```

| 字段 | 类型 | 说明 |
|---|---|---|
| code | number | `0` 成功；非 0 失败，且 **HTTP 状态码 = code**（`wrapError(code, ...)` 后 `c.json(..., code)`） |
| message | string | 成功固定 `"ok"`；失败为**小写英文句子**（非枚举，见 §1.5） |
| data | any | 业务数据；失败时为 `null` |

> `wrapOk` 的实现里 `request_id` 是可选的，但**所有路由均未传**，因此实际响应恒为 `{ code, message, data }` 三项。

> ⚠️ **isError 特例（code-graph 查询工具 / tools/call）**：工具执行失败（`result.isError === true`）时，HTTP 状态码是 **500**，但 body 仍是 `wrapOk(result)` 的**成功信封** `{ code: 0, message: "ok", data: { text, isError: true } }`。即 **`code=0` 但 HTTP=500**，违反上表「HTTP 状态码 = code」的常规约定。前端判断工具失败的唯一标志是 **`data.isError === true`**（错误文案在 `data.text`），不能只看 HTTP 状态或 `code`。

### 1.3 鉴权

KS 走 **内网信任模型**，与 MemoryCore 的 user-key 体系不同：

| 项 | 说明 |
|---|---|
| 唯一必填 Header | `x-tdai-service-id`（租户/service 标识，即内核路由键） |
| 其他鉴权 | 可选 Bearer：`KNOWLEDGE_SERVICE_KEY` 非空时，除只读白名单外的端点需 `Authorization: Bearer <key>`（含 `internal/llm-binding/*` 全部与 `source-credential/*` 的管理面）；为空则不启用（向后兼容，内网信任） |
| 例外 | `POST /v3/internal/llm-binding/list` 不需要 `x-tdai-service-id` 头（返回全部 binding，供 Panel 启动缓存；key 启用时仍需 Bearer） |
| 只读白名单（GET） | `GET /v3/source-credential/status`、`GET /v3/auto-sync/status`（`source-credential` 其余端点均需 Bearer） |

> `service_id` / `team_id` / 资源 ID 统一做**路径分段白名单校验**（`^[A-Za-z0-9_-]+$`、长度 ≤200），防止路径穿越。

### 1.4 ID 与多租户

| 项 | 值 |
|---|---|
| Wiki ID | `wiki-` + 8 位 `[0-9a-z]`（如 `wiki-a1b2c3d4`） |
| Code-Graph ID | `cg-` + 8 位 `[0-9a-z]`（如 `cg-e5f6g7h8`） |
| Git Credential ID | `gc-` + 8 位 `[0-9a-z]`（如 `gc-p9q8r7s6`） |
| 多租户 | 所有接口按 `service_id` 收敛；**id-only 接口用 `getById(service_id, id)`，跨租户资源统一返回 404（不暴露存在性）**。`source-credential` 更进一步：所有读写都同时按 `service_id + team_id` 收敛 |

### 1.5 错误 message 格式

失败 `message` 为**小写英文句子**（非枚举、非 `CODE: detail` 格式），前端按 HTTP `code` 分支，不要解析 message。常见示例：

| code | message 示例 | 场景 |
|---|---|---|
| 400 | `x-tdai-service-id header is required` / `wiki_id is required` / `query is required` | 参数缺失 |
| 400 | `invalid path: traversal detected` / `forbidden path (structural file or outside wiki/)` | 路径非法 |
| 404 | `wiki not found` / `code graph not found` / `source credential not found` | 资源不存在（含跨租户） |
| 409 | `wiki is processing; cannot write/delete` | 状态冲突 |
| 409 | `busy` | 并发拒绝（ingest/sync） |
| 409 | `git credential name already exists in this team: <name>` | 凭证重名 |
| 413 | `content exceeds size limit` / `too many files (max 10)` | 超限 |
| 422 | `invalid SSH private key: …` / `SSH private keys protected by a passphrase are not supported…` | 凭证材料不可用 |
| 503 | `code graph instance not loaded` | 依赖未就绪 |
| 503 | `KNOWLEDGE_SECRET_KEY is not configured; managed git credentials are unavailable…` | 凭证子系统未配置 |

### 1.6 资源状态枚举

| 资源 | 状态值 | 说明 |
|---|---|---|
| Wiki | `draft` → `pending` → `processing` → `ready` / `failed` | `draft` 是 create 建壳初始态 |
| Code-Graph | `pending` / `processing` / `ready` / `failed` | 无 `draft` |

> 常见约定：`ready` 前的状态，查询类接口（graph/search/query tools）返回**空结果而非错误**（见 §3.1/§3.2）。

---

## 2. 接口目录

| 模块 | 接口数 | 前缀 |
|---|---|---|
| Wiki | 16 | `/v3/wiki/*` |
| Code-Graph | 14 | `/v3/code-graph/*` |
| Source-Credential | 7 | `/v3/source-credential/*` |
| Tools（Agent 自发现） | 2 | `/v3/tools/*` |
| Internal LLM-Binding | 3 | `/v3/internal/llm-binding/*` |
| Auto-Sync | 2 | `/v3/auto-sync/*` |

**合计 44 个接口。**

---

## 3. 接口明细

## 3.1 Wiki（16）

> 注释写"15 endpoints"，实际代码 16 个（多一个 `update-meta`）。
> 分两类：**id-only**（仅 `x-tdai-service-id` + `wiki_id`，跨租户 404）与 **with-team**（需 `team_id`）。

**WikiDetail 统一出参**：

| 字段 | 类型 | 说明 |
|---|---|---|
| wiki_id | string | 资源 ID |
| team_id | string | 团队 ID |
| name | string | 名称 |
| service_url | string\|null | tools 自发现 base URL |
| summary | string\|null | 摘要 |
| status | string | 状态（见 §1.6） |
| internal_status | string\|null | 内部细粒度状态 |
| sync_error | string\|null | 同步错误 |
| version | string | 版本号（字符串） |
| owner_user_id | string\|null | owner |
| page_count | number\|null | 页面数 |
| last_sync_at | string\|null | 最近同步时间 |
| created_at / updated_at | string | 时间 |

### POST /v3/wiki/create

建 Wiki 壳（`draft` 状态）。**幂等**：同名同 team 返回已存在记录（HTTP 200），新建返回 201。

**请求体**（with-team）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| name | string | 是 | 名称 |
| user_id / agent_id / task_id | string | 否 | 归属（owner_user_id = user_id） |

**响应** `data`：`WikiDetail`。

**错误**：`400`（缺 team_id 或 name）。

**示例**

```json
// 请求
POST /v3/wiki/create
{ "team_id": "t_1", "name": "团队 wiki" }

// 响应（201）
{
  "code": 0,
  "message": "ok",
  "data": {
    "wiki_id": "wiki-a1b2c3d4",
    "team_id": "t_1",
    "name": "团队 wiki",
    "status": "draft",
    "version": "0",
    "owner_user_id": "u_1",
    "created_at": "2026-08-20T00:00:00Z",
    "updated_at": "2026-08-20T00:00:00Z"
  }
}
```

### POST /v3/wiki/list

按 team 分页列表。

**请求体**：`team_id`(必)、`status?`、`limit?`(默认20)、`offset?`(默认0)。

**响应** `data`：`{ items: WikiDetail[], total }`。

### POST /v3/wiki/get

id-only 单查。

**请求体**：`wiki_id`(必)。

**响应** `data`：`WikiDetail`。

**错误**：`404`(wiki not found)。

### POST /v3/wiki/update-meta

更新 name / summary。

**请求体**：`wiki_id`(必)、`name?`、`summary?`（至少一个）。

**响应** `data`：`WikiDetail`。

**错误**：`400`(两者都没传)、`404`。

### POST /v3/wiki/delete

批量删除（级联清理连接/元数据/磁盘 + 注销 engine）。

**请求体**：`wiki_ids`(1–100，非空数组)。

**响应** `data`：`BatchDeleteResult` = `{ deleted_ids: string[], failed: [{ id, reason }] }`。

> 单个失败不整体报错，写入 `failed`（reason：`invalid id` / `not found` / `delete failed`）。

### POST /v3/wiki/ingest

触发 Wiki 抽取。**空 wiki（无源文件）拒绝**。

**请求体**：`wiki_id`(必)、`user_id?`。

**响应** `data`：`{ wiki_id, status }`（HTTP `202`）。

**错误**：`400`(空 wiki)、`404`(不存在)、`409`(busy，data 带 `{ status, step }`)。

### POST /v3/wiki/raw/ls

列出原始源文件（id-only）。

**请求体**：`wiki_id`。

**响应** `data`：`{ items: RawFile[] }`。

### POST /v3/wiki/raw/read

批量读原始文件（id-only）。

**请求体**：`wiki_id`、`filenames: string[]`（非空）。

**响应** `data`：`{ items }`。

**错误**：`400`(参数)、`404`(wiki 不存在 / 文件缺失)、`413`(过大)。

### POST /v3/wiki/raw/write

上传源文件（with-team）。**触发 ingest 前必须先写 raw**。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| wiki_id | string | 是 | Wiki ID |
| files | object[] | 是 | `[{ filename, content }]`，≤10 个，单文件 ≤512KB，总 ≤5MB |
| user_id / agent_id / task_id | string | 否 | 归属 |

**响应** `data`：`{ items }`。

**错误**：`400`(结构非法)、`404`、`409`(processing)、`413`(超限)。

**示例**

```json
// 请求
POST /v3/wiki/raw/write
{ "team_id": "t_1", "wiki_id": "wiki-a1b2c3d4", "files": [ { "filename": "README.md", "content": "# 首页" } ] }

// 响应
{ "code": 0, "message": "ok", "data": { "items": [ { "filename": "README.md", "status": "written" } ] } }
```

### POST /v3/wiki/raw/rm

删除原始文件（with-team）。

**请求体**：`team_id`、`wiki_id`、`filenames: string[]`。

**响应** `data`：删除结果。

**错误**：`400`、`404`、`409`(processing)。

### POST /v3/wiki/page/ls

列出抽取后的页面（id-only）。

**请求体**：`wiki_id`。

**响应** `data`：`{ items: Page[] }`（`Page = { ref, title, path }`）。

### POST /v3/wiki/page/read

批量读页面（id-only）。

**请求体**：`wiki_id`、`refs: string[]`（非空）。

**响应** `data`：`{ items }`。

**错误**：`400`、`404`。

### POST /v3/wiki/page/write

写页面（with-team）。

**请求体**：`team_id`、`wiki_id`、`pages: [{ ref, content }]`（非空）。

**响应** `data`：`{ items }`。

**错误**：`400`、`404`、`409`(processing)。

### POST /v3/wiki/page/rm

删除页面（with-team）。

**请求体**：`team_id`、`wiki_id`、`refs: string[]`。

**响应** `data`：删除结果。

**错误**：`400`、`404`、`409`(processing)。

### POST /v3/wiki/graph

知识图谱（id-only）。**非 `ready` 返回空图（非错误）**。

**请求体**：`wiki_id`。

**响应** `data`：`{ nodes: [], edges: [], communities: [] }`（未 ready 时为空；ready 时返回 `wikiMgr.graph` 结果）。

### POST /v3/wiki/search

全文搜索（BM25，id-only）。**非 `ready` 返回空结果（非错误）**。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| wiki_id | string | 是 | Wiki ID |
| query | string | 是 | 检索词 |
| limit | number | 否 | 默认 20 |
| hop | number | 否 | 图谱扩展跳数，整数 0–5 |
| decay | number | 否 | 衰减系数 0–1 |
| minScore | number | 否 | 最低相关度（非负） |

**响应** `data`：`{ results, links, count }`。

**错误**：`400`(query 缺失 / hop/decay/minScore 越界)、`404`。

**示例**

```json
// 请求
POST /v3/wiki/search
{ "wiki_id": "wiki-a1b2c3d4", "query": "发版", "limit": 10 }

// 响应
{ "code": 0, "message": "ok", "data": { "results": [ { "ref": "page/发版计划", "title": "发版计划" } ], "links": [], "count": 1 } }
```

---

## 3.2 Code-Graph（14）

> 注释写"13 endpoints"，实际 14 个（多一个 `update-meta`）。
> 分两类：**Management**（6：create/list/get/update-meta/sync/delete）与 **Query**（8：search/explore/callers/callees/impact/node/status/files）。
> Query 委托 `engines/code executeTool`，返回 `{ text, isError }` 文本块。

**CodeGraphDetail 统一出参**：

| 字段 | 类型 | 说明 |
|---|---|---|
| code_graph_id | string | 资源 ID |
| team_id | string | 团队 ID |
| repo_name | string | 仓库名 |
| repo_url | string | 仓库地址 |
| branch | string | 分支（默认 main） |
| commit_hash | string\|null | commit |
| service_url | string\|null | tools 自发现 base URL |
| summary | string\|null | 摘要 |
| status | string | 状态（见 §1.6） |
| sync_error | string\|null | 同步错误 |
| version | string | 版本号 |
| owner_user_id | string\|null | owner |
| stats | `{ files, nodes, edges }`\|null | 统计 |
| last_sync_at | string\|null | 最近同步时间 |
| created_at / updated_at | string | 时间 |

### POST /v3/code-graph/create

建 Code-Graph（`pending`，自动触发 build）。**幂等**：同 repo_url+branch 返回已存在记录（200），新建 201。

**请求体**（with-team）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| repo_url | string | 是 | 仓库地址 |
| branch | string | 否 | 分支，默认 `main` |
| repo_name | string | 否 | 仓库名 |
| user_id / agent_id / task_id | string | 否 | 归属 |

**响应** `data`：`CodeGraphDetail`。

**错误**：`400`(缺 team_id/repo_url)。

**示例**

```json
// 请求
POST /v3/code-graph/create
{ "team_id": "t_1", "repo_url": "https://github.com/org/repo", "branch": "main" }

// 响应（201）
{
  "code": 0,
  "message": "ok",
  "data": {
    "code_graph_id": "cg-e5f6g7h8",
    "team_id": "t_1",
    "repo_name": "repo",
    "repo_url": "https://github.com/org/repo",
    "branch": "main",
    "status": "pending",
    "version": "0",
    "owner_user_id": "u_1"
  }
}
```

### POST /v3/code-graph/list

按 team 分页列表。

**请求体**：`team_id`(必)、`status?`、`limit?`、`offset?`。

**响应** `data`：`{ items: CodeGraphDetail[], total }`。

### POST /v3/code-graph/get

id-only 单查。

**请求体**：`code_graph_id`。

**响应** `data`：`CodeGraphDetail`。

**错误**：`404`。

### POST /v3/code-graph/update-meta

更新 repo_name / summary。

**请求体**：`code_graph_id`、`repo_name?`、`summary?`（至少一个）。

**响应** `data`：`CodeGraphDetail`。

**错误**：`400`、`404`。

### POST /v3/code-graph/sync

触发同步（重建索引）。

**请求体**：`code_graph_id`、`user_id?`。

**响应** `data`：`{ code_graph_id, status }`（HTTP `202`）。

**错误**：`404`、`409`(busy，data 带 `{ status, step }`)。

### POST /v3/code-graph/delete

批量删除。

**请求体**：`code_graph_ids`(1–100，非空)。

**响应** `data`：`BatchDeleteResult`。

---

### 查询工具（8 个，均 id-only）

> 8 个查询接口由 `CODEGRAPH_QUERY_TOOL_NAMES` 统一循环注册，共用同一 handler：
> - 先 `getById(service_id, code_graph_id)` 收敛归属，`404` 兜底；
> - **非 `ready` 返回 `{ text: "", isError: false }`（HTTP 200，非错误）**；
> - 参数按 `QUERY_SPECS` 白名单严格校验，**未声明字段直接 400**（`unexpected field: xxx`）；
> - 委托 `executeTool`，结果 `isError=true` 时 HTTP 500，但 body 仍为 `code=0` 成功信封，失败标志是 `data.isError=true`（见 §1.2 isError 特例）。

| 接口 | 参数（默认值/范围） | 说明 |
|---|---|---|
| `POST /search` | `query`(必)、`kind?`(function/method/class/interface/type/variable/route/component)、`limit?`(默认10，1–100) | 按符号名搜索，只返回位置（不含源码） |
| `POST /explore` | `query`(必)、`maxFiles?`(默认12，1–200) | **首选**：按文件分组返回相关符号完整源码 |
| `POST /callers` | `symbol`(必)、`limit?`(默认20，1–200) | 列出调用 symbol 的函数 |
| `POST /callees` | `symbol`(必)、`limit?`(默认20，1–200) | 列出 symbol 调用的函数 |
| `POST /impact` | `symbol`(必)、`depth?`(默认2，1–10) | 影响分析 |
| `POST /node` | `symbol`(必)、`includeCode?`(默认false)、`file?`、`line?`(≥1) | 单个符号完整信息（可含源码） |
| `POST /status` | 无参数 | 索引健康检查 |
| `POST /files` | `path?`、`pattern?`、`format?`(tree/flat/grouped，默认tree)、`includeMetadata?`(默认true)、`maxDepth?`(≥1) | 索引文件树 |

**统一请求体**：`code_graph_id`(必) + 上表参数。

**统一响应** `data`：`{ text: string, isError: boolean }`。

**统一错误**：`400`(参数)、`404`(code graph not found)、`500`(工具执行失败，`data.isError=true`，body 仍 code=0)、`503`(instance not loaded)。

**示例**（explore）

```json
// 请求
POST /v3/code-graph/explore
{ "code_graph_id": "cg-e5f6g7h8", "query": "用户登录逻辑", "maxFiles": 12 }

// 响应
{
  "code": 0,
  "message": "ok",
  "data": { "text": "```src/auth.ts\n...\n```", "isError": false }
}
```

---

## 3.3 Tools — Agent 自发现（2）

> v7 progressive-exposure：LLM Agent 先 `tools/list` 发现可用工具，再 `tools/call` 执行。
> 仅暴露**只读查询工具**，管理操作（create/delete/ingest/sync）不暴露。
> `knowledge_id` 决定资源类型：`wiki-*` → Wiki 工具集（7），`cg-*` → Code-Graph 工具集（9）。

### POST /v3/tools/list

列出某知识资源可用的工具。

**请求体**：`knowledge_id`(必)。

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| knowledge_id | string | 回显 |
| type | string | `wiki` / `code-graph` |
| name | string | 资源名 |
| summary | string\|null | 摘要 |
| status | string | 资源状态 |
| tools | object[] | `[{ name, description, params }]` |

**错误**：`400`(knowledge_id 缺失/格式非法)、`404`(资源不存在)。

**示例**

```json
// 请求
POST /v3/tools/list
{ "knowledge_id": "wiki-a1b2c3d4" }

// 响应
{
  "code": 0,
  "message": "ok",
  "data": {
    "knowledge_id": "wiki-a1b2c3d4",
    "type": "wiki",
    "name": "团队 wiki",
    "status": "ready",
    "tools": [
      { "name": "search", "description": "BM25 全文搜索 wiki 页面内容", "params": { "query": { "type": "string", "required": true } } }
    ]
  }
}
```

### POST /v3/tools/call

执行工具。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| knowledge_id | string | 是 | 资源 ID |
| tool_name | string | 是 | 工具名 |
| params | object | 是 | 工具参数（按 tools/list 定义） |

**响应** `data`：工具执行结果（wiki 工具返回结构化数据；code-graph 工具返回 `{ text, isError }`）。

**错误**：`400`(参数)、`403`(未知工具)、`404`(资源不存在)、`500`(code-graph 工具执行失败，`data.isError=true`，body 仍 code=0)、`503`(instance not loaded)。

> **工具白名单**（tool_name）：
> - Wiki（7）：`get_info`、`search`、`list_pages`、`read_page`、`get_graph`、`list_raw`、`read_raw`
> - Code-Graph（9）：`get_info`、`search`、`explore`、`callers`、`callees`、`impact`、`node`、`status`、`files`

---

## 3.4 Internal LLM-Binding（3）

> 每实例 LLM 路由配置，控制面（TMC / operator curl）。`api_key` 永不回显。

### POST /v3/internal/llm-binding/set

upsert binding（`proxy`\|`byo`）。**幂等**：重复 set 覆盖。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| mode | string | 是 | `proxy` / `byo` |
| proxy_base_url | string | proxy 必填 | 代理 LLM 地址 |
| base_url | string | byo 必填 | 自建 LLM 地址 |
| api_key | string | 首次必填 | 已存在记录不传则保留原值 |
| enabled | boolean | 否 | 默认 true |

**响应** `data`：`{ service_id, mode, enabled, updated_at }`（**不含 api_key**）。

**错误**：`400`(mode 非法 / 缺地址 / 首次缺 api_key)。

### POST /v3/internal/llm-binding/status

读 binding 状态（不含 api_key）。

**响应** `data`

| 字段 | 类型 | 说明 |
|---|---|---|
| bound | boolean | 是否已配置 binding |
| mode | string\|null | `proxy` / `byo`；未配置为 `null` |
| enabled | boolean | 是否启用；未配置为 `false` |

> 未配置时返回 `{ bound: false, mode: null, enabled: false }`。

### POST /v3/internal/llm-binding/list

列出全部 binding（**不需要 `x-tdai-service-id` 头**）。

**响应** `data`：`{ items: [{ service_id, mode, proxy_base_url, base_url, has_api_key, enabled }] }`。

---

## 3.5 Auto-Sync（2）

> 定时同步调度器的状态查询 + 手动触发。**无鉴权**。是 v3 里罕见的含 GET 的模块。

### GET /v3/auto-sync/status

查询调度器运行状态 + 配置。

**响应** `data`：`{ running, activeSyncs, scanning, ... , config: { enabled, scanIntervalMs, maxConcurrentSyncs } }`。

### POST /v3/auto-sync/trigger

手动触发一轮全量扫描（fire-and-forget，立即返回）。

**响应** `data`：`{ triggered: boolean, reason? }`（`KNOWLEDGE_AUTO_SYNC_ENABLED` 关闭时 `triggered=false` + reason）。

---

## 3.6 Source-Credential（7）

> 托管 git 凭证，让 Code-Graph 能索引**私有仓库**。命名沿用 auth 白名单里既有的
> `/source-credential/status` 占位——凭证是「某个 source 的凭证」（git 今天，local/ftp 以后），
> 不是 git 专属。
>
> **密钥永不回显**：所有响应只含 16 位 HMAC 指纹与元数据。
> 需要 `KNOWLEDGE_SECRET_KEY`（≥32 字节）才能读写；未配置时 create 返回 503。
>
> ⚠️ **授权边界**：KS 没有成员数据、鉴权只有一把全局 service key，因此
> 「谁有权操作某 team 的凭证」必须由 **Panel 侧按团队成员门控**。KS 不应直接暴露给终端用户。

**SourceCredentialDetail 统一出参**：

| 字段 | 类型 | 说明 |
|---|---|---|
| credential_id | string | 资源 ID（`gc-` 前缀） |
| team_id | string | 团队 ID |
| name | string | 名称（同 service+team 内唯一） |
| kind | string | `https_token` / `ssh_key` |
| host | string | 归一化后的 host（小写、无尾点）；凭证**只对该 host 生效** |
| username | string\|null | HTTPS 用户名（`ssh_key` 为 null） |
| fingerprint | string | HMAC(主密钥, 明文) 前 16 位 hex |
| created_by | string\|null | 创建者（不可信，仅审计） |
| created_at / updated_at | string | 时间 |

### POST /v3/source-credential/create

托管一份凭证。

**请求体**（with-team）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| name | string | 是 | 名称，≤120 字符 |
| kind | string | 是 | `https_token` / `ssh_key` |
| host | string | 是 | **必填**。凭证只对该 host 生效（防止拿团队 token 去打任意主机）。写 host 即可，不要带端口 |
| username | string | 否 | HTTPS 用户名，默认 `oauth2`。GitHub App installation token 必须传 `x-access-token` |
| secret | string | 是 | token 或 PEM 私钥明文，≤64KB |
| user_id | string | 否 | 仅记入 `created_by` 与审计 |

**响应** `data`：`SourceCredentialDetail`（HTTP 201）。

**错误**：`400`（缺 team_id/name/kind/host/secret 或 kind 非法）、`409`（同 team 重名）、
`422`（SSH 私钥非法或带 passphrase）、`503`（`KNOWLEDGE_SECRET_KEY` 未配置）。

### POST /v3/source-credential/list

列出本 team 的凭证（全部掩码）。

**响应** `data`：`{ items: SourceCredentialDetail[], total }`。

### POST /v3/source-credential/get

**请求体**：`{ team_id, credential_id }`。**响应** `data`：`SourceCredentialDetail`。

**错误**：`400`（缺 team_id/credential_id）、`404`（不存在**或跨 team/跨 service**）。

### POST /v3/source-credential/delete

批量删除（软删，留痕）。

**请求体**：`{ team_id, credential_ids: string[] }`（非空，≤100）。

**响应** `data`：`{ deleted_ids, failed: [{ id, reason }] }`。

### POST /v3/source-credential/test

用该凭证探测目标仓库连通性（`git ls-remote --heads`），不落盘。

**请求体**（with-team）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| team_id | string | 是 | 团队 ID |
| credential_id | string | 是 | 凭证 ID |
| repo_url | string | 是 | 目标仓库 URL |
| branch | string | 否 | 给了但远端不存在时 `ok=true` + `note`（凭证本身可用） |

**响应** `data`：`{ ok: boolean, error?: string, note?: string }`（error 已脱敏）。

**错误**：`400`（缺字段 / repo_url 非法 / 未过协议白名单与 SSRF 校验）、
`404`（凭证不存在、跨 team，**或 `repo_url` 的 host 与该凭证声明的 host 不一致**）。

> 三重门顺序：① 凭证归属（service+team）→ ② **host 严格相等** → ③ `repo_url` 过
> source-fetcher 的协议白名单 / SSRF / host 白名单校验。任一门不过都不发起探测。

### GET /v3/source-credential/status

凭证子系统状态（**只读白名单，无需 Bearer**）。仅回非租户数据。

**Header**：需要 `x-tdai-service-id`。

**响应** `data`：`{ configured: boolean, count: number, kinds: string[] }`。

### GET /v3/source-credential/providers

支持的凭证类型与其配置要求（静态信息，不含实例数据）。

**响应** `data`：`{ providers: [{ kind, label, default_username?, fields, note }] }`。

### 与 Code-Graph 的联动

- `POST /v3/code-graph/create` 新增可选 `credential_id`：校验凭证存在、同 `service_id`+`team_id`，
  且 **`credential.host === normalizeHost(repo_url)`**，不通过则 `404`。
  缺省（不传）= 匿名访问公开仓库，行为与本次变更前一致。
- `POST /v3/code-graph/update-meta` 新增可选 `credential_id`（`null` 表示解绑），**校验强度与 create 完全一致**
  —— 否则「先建后换绑」会成为绕过 host 绑定的越权通道。
- `CodeGraphDetail` 新增 `credential_id: string|null`（**仅引用，非密钥**）。

---

## 4. 附录

### 4.1 与 MemoryCore 的关键差异（跨卷对接必读）

| 维度 | MemoryCore（卷一） | MemoryKnowledge（本卷） |
|---|---|---|
| 信封 | `{ code, message, request_id, data }` | `{ code, message, data }`（**无 request_id**） |
| 鉴权 | Bearer + service-id + user-key 分层 | 仅 `x-tdai-service-id`（内网信任） |
| 错误 message | 三类格式（枚举 / 5 位 code / `CODE: detail`） | 小写英文句子（按 HTTP code 分支） |
| 分页出参 | `{ items, total, limit, offset }` | `{ items, total }`（无 limit/offset 回显） |
| ID 前缀 | skill `skl-` 等 | wiki `wiki-`、code-graph `cg-`、git credential `gc-` |

### 4.2 接口计数修正说明

| 文件 | 注释声明 | 实际 | 差异 |
|---|---|---|---|
| `wiki.ts` | 15 endpoints | 16 | 多 `update-meta` |
| `code-graph.ts` | 13 endpoints | 14 | 多 `update-meta` |

### 4.3 幂等约定汇总

| 接口 | 幂等行为 |
|---|---|
| `wiki/create` | 同名同 team 返回已存在记录（200，非报错） |
| `code-graph/create` | 同 repo_url+branch 返回已存在记录（200） |
| `source-credential/create` | **不幂等**：同 team 重名返回 409（凭证是密钥，静默覆盖会造成「以为换掉了其实没换」） |
| `source-credential/delete` | 软删；再次删除同一 id 记入 `failed`（reason `not found`） |
| `llm-binding/set` | 重复 set 覆盖（api_key 不传保留原值） |
| `wiki/delete`、`code-graph/delete` | 单个失败不整体报错，写入 `failed` 数组 |
