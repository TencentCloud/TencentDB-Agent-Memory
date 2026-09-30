# TDAI 多账号记忆接入落地设计

> 状态：设计文档，待 PoC。
> 最后更新：2026-06-26。
> 适用范围：AI4ALL 微信个人 AI 陪伴项目。
> 上游参考：
> - `/Users/suchong/workspace/TencentDB-Agent-Memory`
> - `docs/plans/记忆机制_tdai化对齐.md`
> - `docs/tech_design/thick_node_postgres_refactor.md`
> - `docs/tech_design/identity_model_and_wechat_binding.md`

## 1. 结论

Gemini 原方案给出的方向有价值：TDAI 的 L0/L1/L2/L3 分层、query-time recall、异步提纯和多租户隔离，确实适合 AI4ALL。  
但它对现状有几个关键误判，不能直接作为实施方案：

1. TDAI 当前不是 Python SDK，也没有可直接内嵌到 FastAPI 的 `AsyncMemoryClient`。
2. TDAI 当前可落地接入面是 Node.js Gateway / OpenClaw 插件能力，HTTP API 包括 `/recall`、`/capture`、`/search/memories`、`/search/conversations`、`/session/end`、`/seed`。
3. TDAI 当前 store backend 是 `sqlite` 或 `tcvdb`，不是 PostgreSQL / pgvector；如果要统一落到 AI4ALL PostgreSQL，需要新增 TDAI store backend，不能在 AI4ALL 侧单方面配置出来。
4. AI4ALL 的业务隔离边界是 `ai4all_account_id`，代码和 DB 里历史字段叫 `account_id`；OpenClaw 原始 `session_key` / `channel_account_id` 不是记忆隔离主键。
5. AI4ALL 已有 `messages`、`account_profile_files`、`memory_writer.py`、`dreaming.py`、`PromptBuilder` 和 PostgreSQL 垫片，接入必须沿这些边界做最小改动，而不是替换整条 turn 链路。

因此推荐采用两阶段策略：

- **近期可落地**：把 TDAI 作为本机 sidecar，通过 HTTP 接入 AI4ALL turn 热路径。TDAI 自己维护本地 SQLite 或 TCVDB 记忆库；AI4ALL 继续以 PostgreSQL/SQLite 抽象作为业务真相。
- **后续可选**：当 sidecar 效果验证后，再评估是否给 TDAI 增加 `postgres` store backend，把 L0/L1/L2/L3 统一收敛到中心 PG。

> **关键修正（2026-06，blocker）：`session_key` 不足以隔离多账号。** 经核实 TDAI 当前 standalone/sqlite store 是「单租户 per dataDir」：`session_key` 只隔离了 L0（原始对话）和 pipeline/session 状态，**L1/L2/L3 召回是 dataDir 全局的**——L1 搜索接口（`store/types.ts:269-270` 的 `searchL1Fts`/`searchL1Vector`）签名里没有 session 过滤；persona/scene 是 dataDir 根级文件（`auto-recall.ts:148/162`）。因此「一个 sidecar 靠 `session_key` 服务多账号」会跨账号召回，**违反 AI4ALL「按账号隔离」红线**。已确认方向：在 P1 灰度前对 TDAI 做**多租户改造（路 B，§8.4）**，并补 `/recall` response 丢失的 `prependContext`（§5.3、§8.4）。这两项是 P1 前置，不是可选优化。

### 1.1 部署现状（2026-06，影响接入形态）

- 数据库为 **中心化 PostgreSQL**。线上两节点：一个节点跑 PostgreSQL，另一个节点经内网连接调用。PG 是全局业务真相，`messages` 等表集中存储。
- 微信接入点的特殊性导致 **用户与节点强绑定**：每个用户的入口只能落到某一台机器节点，该用户的业务主逻辑也全部在这台节点上运行。用户不会在节点间漂移（除非显式迁移）。

这两点不推翻 sidecar 方案，反而强化它：

1. **用户强绑定节点 → 本地 SQLite 不再是妥协，而是天然契合**。同一用户所有轮次都在同一节点处理，本地记忆不会跨节点碎片化（§4.2 旧约束被微信绑定语义自动满足）。
2. **中心 PG 已持有全量 `messages` → TDAI 记忆可从中心重建**。节点故障/迁移的恢复路径是「新节点起 sidecar + 从中心 PG re-seed」，而非搬运本地 SQLite。源真相在中心、派生记忆在本地且可重建，是稳的混合形态。
3. **中心 PG 让未来 `postgres` store backend 成为真实可选项（P4）**，但要改 TDAI TypeScript store、依赖 pgvector，并给热路径 recall 增加一次跨节点网络往返；近期不做。

### 1.2 接入点完整度（轴 A）≠ provider 抽象（轴 B）

「完整实现 OpenClaw-like 接入」要区分两个正交的轴：

- **轴 A — 接入点完整度**：是否把 OpenClaw 暴露的所有 host 点都接上（recall / capture / 模型主动 search 工具 / session-end / shutdown flush）。**目标做满**，详见 §2.3。
- **轴 B — provider 抽象层**：是否建抽象 `MemoryProvider` 基类 + 多实现（TdaiHttp / NativePg / Noop）热插拔。**推迟到 P3/P4**：在出现第二个实现之前用单一实现去定接口，几乎必然返工；当前 `app/tdai_client.py` 的模块边界已提供「调用不散落、可降级、可灰度」的全部收益。

第一版接口面 = `tdai_client.py` 的几个具体函数，不套抽象基类。

## 2. 当前系统映射

### 2.1 AI4ALL 现有热路径

当前用户入站链路是：

```text
OpenClaw bridge
  -> /openclaw/turn
  -> app/turn_service.py
  -> build_turn_llm_input()
  -> PromptBuilder.assemble()
  -> generate_reply_with_tools()
  -> insert_message / billing / moderation
  -> memory_writer.write_memory()
  -> dreaming scheduler 或 admin run-once
```

现有记忆材料：

| 层次 | AI4ALL 当前实现 | 说明 |
|---|---|---|
| L0 原始会话 | `messages` 表 | 每轮用户/助手可见文本，按 `account_id` 隔离 |
| L0 daily notes | `app/memory_writer.py` -> `account_profile_files.filename = memory/YYYY-MM-DD.md` | turn 后异步追加，已入 DB-backed profile storage |
| session continuity | `sessions.carryover_summary` | session 轮转后承接上一段对话 |
| 长期上下文 | `SOUL.md` / `IDENTITY.md` / `USER.md` / `MEMORY.md` | 通过 `read_agent_context()` 进入 `Project Context` |
| 整理审计 | `dreaming_runs` / `dreaming_memory_items` / `memory_events` | Dreaming 输出、自动应用和 diff 审计 |

### 2.2 TDAI 当前能力

TDAI 仓库关键入口：

| 文件 | 作用 |
|---|---|
| `src/core/tdai-core.ts` | Host-neutral facade，提供 recall/capture/search/session end |
| `src/gateway/server.ts` | HTTP Gateway，暴露 `/recall`、`/capture`、`/search/*`、`/session/end`、`/seed` |
| `src/gateway/types.ts` | Gateway 请求/响应类型 |
| `src/config.ts` | TDAI 配置，包含 capture/extraction/persona/pipeline/recall/embedding/storeBackend |
| `src/core/store/factory.ts` | store backend 选择：`sqlite` 或 `tcvdb` |
| `src/core/hooks/auto-recall.ts` | query-time L1 recall + L3 persona + L2 scene navigation 注入 |
| `src/core/hooks/auto-capture.ts` | turn 后 L0 capture + pipeline notify |

Gateway API 形态：

```http
GET  /health
POST /recall
POST /capture
POST /search/memories
POST /search/conversations
POST /session/end
POST /seed
```

其中 `/recall` 返回：

```json
{
  "context": "<user-persona>...</user-persona>...",
  "strategy": "hybrid",
  "memory_count": 3
}
```

`/capture` 输入：

```json
{
  "user_content": "用户本轮文本",
  "assistant_content": "助手回复",
  "session_key": "ai4all:aid_806382741",
  "session_id": "123",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ]
}
```

注意：Gateway type 里有 `user_id`，但当前 `src/gateway/server.ts` 并未把它传入 `TdaiCore` 的 recall/capture 主逻辑。当前 TDAI 的隔离和 pipeline state 实际依赖 `session_key`。

### 2.3 OpenClaw host 点完整映射（轴 A 的目标范围）

TDAI 的 `TdaiCore` 是 host-neutral facade，OpenClaw 插件与 Gateway 是它的两个 host adapter；**Gateway 就是 standalone host**，HTTP 端点逐一对应 facade 方法（核对自 TDAI `index.ts` 的 `api.on(...)` 与 `src/core/tdai-core.ts`）。OpenClaw 插件注册的 5 个 host 点映射到 AI4ALL：

| OpenClaw host 点 | TdaiCore facade | Gateway 端点 | AI4ALL 落点 | 阶段 |
|---|---|---|---|---|
| `before_prompt_build`（被动召回 L1+L3+L2 注入 prompt） | `handleBeforeRecall(userText, sessionKey)` | `POST /recall` | `build_turn_llm_input()` → `extra_blocks` 的 `tdai_recall_memories` + `tdai_recall_persona` | P1 |
| `before_message_write`（剥离注入标签防污染历史） | — | — | **N/A**：recall 作为独立 system block 注入，从不写回 `messages.content`，架构天然满足 | — |
| `agent_end`（捕获 user+assistant 轮，推进 L0→L1→L2→L3） | `handleTurnCommitted(turn)` | `POST /capture` | after-turn 复用 `write_memory` 的 background_loop 派发 | P1 |
| `registerTool`：`tdai_memory_search` / `tdai_conversation_search`（模型主动召回，每轮合计上限 3 次） | `searchMemories` / `searchConversations` | `POST /search/memories`、`/search/conversations` | 加进 `generate_reply_with_tools` 的 tool registry（§5.6） | P1 |
| `gateway_stop`（flush pipeline、关 store） | `handleSessionEnd` + `destroy()` | `POST /session/end` | `session_lifecycle` 轮转 + FastAPI shutdown（§5.5） | P2 |

要达到「完整 OpenClaw-equivalent」，除已规划的被动 recall + capture 外，还需补两块（旧版本漏列）：

1. **模型主动 search 工具**（§5.6）：让模型在生成中途自行查记忆，覆盖被动召回未命中的「我上次说的那个事」类追问。Gateway `/search/*` 现成，只需加 tool 壳并复制「每轮合计 3 次」硬上限。
2. **session-end / shutdown flush**（§5.5）：pipeline 是进程内串行队列，session 轮转与进程退出要给它 flush 机会，否则刚 capture 的 L0 可能未提纯就丢失。

`before_message_write` 我们不需要实现——独立 block 注入天然不污染历史。

## 3. 关键设计决策

### 3.1 接入形态：sidecar 优先，不做 Python 内嵌

推荐形态：

```text
AI4ALL FastAPI 进程
  |
  | HTTP localhost + Bearer token
  v
TDAI Gateway Node 进程
  |
  +-- 本地 SQLite/sqlite-vec 或 Tencent Cloud VectorDB
  +-- TDAI pipeline: L0 -> L1 -> L2 -> L3
```

理由：

- 与 TDAI 真实实现一致，PoC 成本最低。
- 不需要在 AI4ALL 里引入 Node/TypeScript 运行时代码。
- 故障边界清晰：TDAI 失败时 AI4ALL 可降级为现有 memory/dreaming。
- 保留后续替换 store backend 的空间。

不建议近期做：

- 不建议直接改 TDAI 为 Python SDK。
- 不建议一开始就把 TDAI 全部迁到 AI4ALL PostgreSQL。
- 不建议让 TDAI OpenClaw 插件直接介入当前微信 bot 的 OpenClaw runtime；AI4ALL 已经自己接管了 prompt、tool、计费、审核和记忆链路，插件式 hook 容易和现有业务链路重叠。

注意「完整接入」≠ 现在建 provider 协议：接入点做满（轴 A，§2.3）与抽象接口（轴 B）是两件事，第一版接口面就是 `app/tdai_client.py` 的几个函数（见 §1.2）。

### 3.2 多账号隔离：TDAI session_key 必须绑定 AI4ALL account_id

AI4ALL 隔离主键：

```text
业务主键：ai4all_account_id
代码/DB 兼容字段：account_id
通道身份：channel_account_id
OpenClaw 会话键：session_key
```

TDAI 当前实际按 `session_key` 分 session/pipeline/checkpoint/recall。因此 AI4ALL 调 TDAI 时必须构造稳定 key：

```python
tdai_session_key = f"ai4all:{account_id}"
tdai_session_id = str(session["id"])
```

不要使用：

- 不要用 OpenClaw payload 原始 `session_key` 作为 TDAI session key。
- 不要用 `channel_account_id` 作为 TDAI session key。
- 不要按 AI4ALL session id 单独隔离长期记忆，否则 L3 persona 和 L1 memories 会按会话碎片化，无法跨 session 生效。

`session_id` 可以传 AI4ALL 当前 `sessions.id`，用于 TDAI L0/L1 溯源；但长期隔离仍以 `tdai_session_key = ai4all:{account_id}` 为准。

### 3.3 Prompt 防污染

TDAI recall 返回的上下文只能进入本轮 prompt，不能写回：

- `messages.content`
- `memory/YYYY-MM-DD.md`
- 用户原始消息
- assistant 可见回复之外的材料

AI4ALL 当前 `build_turn_llm_input()` 已经先读 history，再构造 system prompt；只要把 TDAI recall block 放进 `PromptBuilder` 的动态 block，且不改落库的 `text/reply`，即可保持存储态干净。

建议新增两个 block name（对应 `/recall` 的 prepend/append 两段，§5.3）：

```text
tdai_recall_memories   # prepend_context：当前 query 相关 L1 记忆
tdai_recall_persona    # append_context：persona/scene 背景
```

注入内容建议包一层 AI4ALL 自己的说明，避免让 TDAI 原始标签成为回答风格主导：

```text
【系统召回记忆】
以下材料来自长期记忆召回，只作为理解用户的参考，不是用户本轮原话。
如果与用户本轮说法冲突，以用户本轮为准，可轻量确认。

<TDAI 返回 context>
```

### 3.4 与现有 dreaming 的关系

近期不替换 `dreaming.py`。两套系统并行：

| 能力 | 近期权威 |
|---|---|
| AI4ALL 业务上下文文件 | 现有 `account_profile_files` + `dreaming.py` |
| TDAI recall/capture 效果评估 | TDAI sidecar |
| billing/moderation/proactive | AI4ALL 现有链路 |
| 用户可见回复 | AI4ALL LLM 链路 |

并行期的目标不是一次性迁移，而是回答两个问题：

1. TDAI 的 L1 recall / L3 persona 是否明显改善陪伴感和长期一致性？
2. TDAI pipeline 的成本、延迟、稳定性是否适合微信陪伴业务？

如果答案稳定为是，再决定是否减少 `MEMORY.md` 的 prompt 权重，或把 `dreaming.py` 改为生成 TDAI seed/records。

## 4. 目标架构

### 4.1 单机 PoC 架构

```text
┌───────────────────────────────┐
│ AI4ALL FastAPI                 │
│ - turn_service.py              │
│ - PromptBuilder                │
│ - messages / billing / audit   │
│ - existing dreaming            │
└───────────────┬───────────────┘
                │ localhost HTTP
                │ Authorization: Bearer <TDAI_GATEWAY_API_KEY>
┌───────────────▼───────────────┐
│ TDAI Gateway                   │
│ - /recall before LLM           │
│ - /capture after reply         │
│ - /seed for backfill           │
│ - pipeline L0/L1/L2/L3         │
└───────────────┬───────────────┘
                │
┌───────────────▼───────────────┐
│ TDAI store                     │
│ Phase 0: local SQLite          │
│ Phase 1 option: TCVDB          │
│ Future: PostgreSQL backend     │
└───────────────────────────────┘
```

### 4.2 线上拓扑与多节点部署

线上现状（2026-06）：两节点，中心化 PostgreSQL。

```text
节点 A
  PostgreSQL（中心业务真相：账号/绑定/计费/审核/messages）
  + AI4ALL app + TDAI Gateway + OpenClaw + TDAI 本地 store

节点 B（经内网连节点 A 的 PG）
  AI4ALL app + TDAI Gateway + OpenClaw + TDAI 本地 store
```

> 已确认（2026-06）：两节点都跑 AI4ALL app，节点 A 同时是 PG 节点。因此**每个节点各起一个 TDAI sidecar**，服务本节点的多个账号。
>
> ⚠️ **多账号共享一个 sidecar 必须先完成 TDAI 多租户改造（路 B，§8.4）**：当前 standalone store 的 L1/L2/L3 是 dataDir 全局的，未改造前一个 sidecar 服务多账号会跨账号召回。改造后该 sidecar 按账号命名空间隔离 L0/L1/L2/L3，对外仍只暴露一个 Gateway。

关键：**微信接入点把用户强绑定到某一台节点**，该用户所有轮次都在同一节点处理。因此：

- TDAI sidecar **与处理该用户的 app 实例同节点**，localhost HTTP 调用；该用户的 L0/L1/L2/L3 都落在这台节点的本地 store，并**按账号命名空间隔离**（§8.4）。
- 用户不跨节点漂移 → 本地 SQLite 记忆**不会碎片化**。§4.1 的「账号稳定归属同一节点」约束被微信绑定语义自动满足，不再是额外灰度门槛。

故障与迁移（DR，第一期）：

- 第一期采用**硬绑定 + 故障暂停**：某节点宕机时，其上用户暂停服务，不做跨节点热备/重绑。
- 中心 PG 持有全量 `messages`，TDAI 本地记忆是**可重建的派生数据**：节点恢复后 sidecar 重启，本地 SQLite 完好则续用；若本地 store 丢失，从中心 PG re-seed 重建（`scripts/seed_tdai_memory.py`），无需搬运 SQLite 文件。
- 后续若上热备/重绑，再评估共享 store（TCVDB 或 PostgreSQL backend，§9 P4）；那时才需处理「用户在节点间漂移」的记忆一致性。

## 5. AI4ALL 代码接入点

### 5.1 新增 TDAI client 模块

建议新增：

```text
app/tdai_client.py
tests/test_tdai_client.py
```

职责：

- 读取配置。
- 封装 `httpx` 调用。
- 统一超时、鉴权、错误降级和日志。
- 提供同步接口给当前同步 turn 热路径使用。

建议接口：

```python
def tdai_session_key(account_id: str) -> str:
    """Return stable TDAI session key scoped to one AI4ALL account."""
    return f"ai4all:{account_id}"


def recall(
    *,
    account_id: str,
    query: str,
    timeout_seconds: float | None = None,
) -> dict:
    """Recall TDAI memory for one account. Return empty dict on disabled/failure."""


def capture_turn(
    *,
    account_id: str,
    session_id: int,
    user_content: str,
    assistant_content: str,
    messages: list[dict] | None = None,
) -> dict:
    """Capture one visible user/assistant turn into TDAI. Best-effort."""
```

### 5.2 配置项

新增到 `app/config.py` 和 `.env.example`：

```python
tdai_enabled: bool = False
tdai_gateway_url: str = "http://127.0.0.1:8420"
tdai_gateway_api_key: str = ""
tdai_recall_enabled: bool = True
tdai_capture_enabled: bool = True
tdai_recall_timeout_seconds: float = 1.5
tdai_capture_timeout_seconds: float = 2.0
tdai_recall_max_chars: int = 2500
tdai_account_allowlist: str = ""
```

默认关闭，按账号 allowlist 灰度。

### 5.3 recall 注入点

位置：`app/turn_service.py` 的 `build_turn_llm_input()`。

⚠️ **依赖 TDAI `/recall` 补丁（§8.4 #6，P0 前置）**：TDAI recall 把最核心的「当前 query 相关 L1 记忆」放在 `prependContext`，把 persona/scene/tools 放在 `appendSystemContext`；但当前 Gateway `/recall` **只返回 `appendSystemContext`，丢弃 `prependContext`**（`server.ts:385`），且 `memory_count` 仍报 L1 条数 > 0。未打补丁就接 `/recall`，会拿到 persona/scene 却拿不到 query 相关记忆，PoC 必然误判召回效果。补丁后 response 同时返回两段。

建议流程：

```text
1. 解析 account_id、session、history、agent_context。
2. 如果 tdai_enabled 且账号命中灰度：
   - 调 /recall，query = 当前用户文本。
   - 超时或失败返回空，不阻塞主对话。
   - 对 prepend/append 两段分别做最大字符数截断。
3. 注入为 PromptBuilder.extra_blocks 中两个 volatile block：
   - tdai_recall_memories（prepend_context：当前 query 相关 L1 记忆，每轮变化）
   - tdai_recall_persona（append_context：persona/scene，变化慢）
4. metadata 记录 tdai_recall_enabled / status / mem_chars / persona_chars / memory_count / latency_ms。
```

`trim_priority` 建议：

```python
ContextBlock(
    name="tdai_recall_memories",   # prepend_context：当前 query 相关 L1 记忆
    text=formatted_tdai_memories,
    section="volatile",
    char_limit=settings.tdai_recall_max_chars,
    trim_priority=25,
)
ContextBlock(
    name="tdai_recall_persona",    # append_context：persona/scene，相对稳定
    text=formatted_tdai_persona,
    section="volatile",
    char_limit=settings.tdai_recall_max_chars,
    trim_priority=35,
)
```

优先级说明：

- `tdai_recall_memories` 比 `carryover_summary` 稍高或接近，因为它是当前 query 相关材料；persona 块稍低，作为背景。
- 低于 onboarding/context 基础身份，避免新用户流程被记忆块干扰。

### 5.4 capture 调用点

位置：主 LLM 回复成功、assistant message 落库后。

当前 `turn_service.py` 已调用 `write_memory()`。TDAI capture 可以与 `write_memory()` 同级，best-effort 异步执行：

```text
1. 用户消息和助手回复都已确定。
2. 入站内容未被同步审核拦截。
3. 回复不是 no_reply / error fallback，或按配置允许记录 fallback。
4. 调 /capture：
   - session_key = ai4all:{account_id}
   - session_id = 当前 AI4ALL session id
   - user_content = 原始用户可见文本
   - assistant_content = 最终发送给用户的文本
```

不要把 system prompt、tool result、TDAI recall context 写入 capture 的 messages，除非后续明确要做短期任务 offload。第一阶段只捕获用户和助手可见文本。

### 5.5 session end / seed

AI4ALL session 生命周期由 `session_lifecycle.py` 控制。**session-end / shutdown flush 属 P2 范围**：pipeline 是进程内串行队列，需在 session 轮转、Dreaming run 后、以及 FastAPI shutdown 时给它 flush 机会，避免刚 capture 的 L0 未提纯丢失。调用：

```http
POST /session/end
{"session_key": "ai4all:<account_id>"}
```

`/seed` 用于历史回灌。建议先做脚本，不放进主链路：

```text
scripts/seed_tdai_memory.py
```

输入：

- `--account-id aid_...`
- `--since YYYY-MM-DD`
- `--limit-sessions N`
- `--dry-run`

数据来源：

- `messages` 表，按 `account_id` 和 session 分组。
- 每组映射到 TDAI seed Format A/B。

### 5.6 模型主动 search 工具

对应 OpenClaw 的 `registerTool`（§2.3），把两个工具加进 `generate_reply_with_tools` 的 tool registry，让模型在生成中途主动召回：

| 工具 | Gateway 端点 | 用途 |
|---|---|---|
| `tdai_memory_search` | `POST /search/memories` | 召回结构化长期记忆（偏好/事件/指令） |
| `tdai_conversation_search` | `POST /search/conversations` | 召回历史原始消息片段 |

要求：

- 两个工具调用都必须带 `session_key = ai4all:{account_id}`，复用 `tdai_client.tdai_session_key()` 唯一构造点。
- ⚠️ **`/search/memories` 当前无 `session_key` 字段**（`gateway/types.ts:66`），`tdai_memory_search` 直接接会**全库跨账号搜 L1**。必须先完成 §8.4 #3（给 `MemorySearchRequest` 加 `session_key` 并下推过滤）才能开放此工具。`/search/conversations` 已带 `session_key`，我们的工具会强制传入，可先行；但注意它当前是**检索后过滤**（`conversation-search.ts:224`），多租户下召回质量需靠 §8.4 #2 的下推改善。
- 复制 TDAI 的硬上限：两个工具**每轮合计最多 3 次**，超出直接拒绝，避免模型刷召回拖慢回复。
- 工程量提示：tool registry 是 schema/handler 单一事实源 + 启动期双向校验（`app/tools/registry.py`），接入需改 `definitions.py`/`registry.py`、新增 handler、给 `TurnContext` 加 per-turn 计数、并按 allowlist/runtime flag gating，不是塞两个 schema 即可。
- 失败降级：工具返回空结果而非抛错，不打断本轮生成。
- 与被动 recall（§5.3）并存：被动注入覆盖高频上下文，主动 search 覆盖被动未命中的精确追问。

## 6. TDAI Gateway 部署配置

### 6.1 本地 Gateway

Gateway 默认端口是 `8420`，建议绑定 loopback 并开启 Bearer token：

```bash
export TDAI_GATEWAY_HOST=127.0.0.1
export TDAI_GATEWAY_PORT=8420
export TDAI_GATEWAY_API_KEY=change-me
export TDAI_DATA_DIR=/var/lib/ai4all/tdai
export TDAI_LLM_BASE_URL=https://api.deepseek.com/v1
export TDAI_LLM_API_KEY=...
export TDAI_LLM_MODEL=deepseek-v4-flash
```

必须要求：

- 非 loopback 暴露时必须设置 `TDAI_GATEWAY_API_KEY`。
- AI4ALL 侧只配置同一个 token，不写死密钥。
- TDAI data dir 纳入备份策略。

### 6.2 TDAI memory 配置建议

PoC 阶段建议：

```yaml
server:
  host: 127.0.0.1
  port: 8420
  apiKey: ${TDAI_GATEWAY_API_KEY}

data:
  baseDir: /var/lib/ai4all/tdai

llm:
  baseUrl: ${TDAI_LLM_BASE_URL}
  apiKey: ${TDAI_LLM_API_KEY}
  model: ${TDAI_LLM_MODEL}
  timeoutMs: 120000

memory:
  timezone: Asia/Shanghai
  storeBackend: sqlite
  capture:
    enabled: true
    l0l1RetentionDays: 0
  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutSeconds: 600
    l2DelayAfterL1Seconds: 10
    l2MinIntervalSeconds: 900
    l2MaxIntervalSeconds: 3600
    sessionActiveWindowHours: 24
  recall:
    enabled: true
    maxResults: 5
    maxTotalRecallChars: 2000
    scoreThreshold: 0.3
    strategy: hybrid
    timeoutMs: 1200
  embedding:
    enabled: true
    provider: dashscope                                  # 非 local/none → 走 OpenAI 兼容远程路径
    baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1
    apiKey: ${TDAI_EMBEDDING_API_KEY}                    # 百炼 DashScope key，与 DeepSeek key 是两把不同的 key
    model: text-embedding-v3
    dimensions: 1024                                     # 可降到 768/512 省存储
    sendDimensions: true                                 # v3 支持指定维度；若兼容模式返回 400 改为 false
    recallTimeoutMs: 1500                                # recall 路径短超时，别拖慢出话
```

说明：

- **embedding 选型：阿里云百炼 `text-embedding-v3`（远程）**。决定性因素是轻量服务器内存：节点 A 已压着 PG + app + sidecar，<3G 可用，本地 `embeddinggemma-300m`（`node-llama-cpp` 进程内加载）常驻 ~0.5–1G，叠加后有真实 OOM 风险；远程方案在本机内存占用 ≈0，仅一次 HTTP。成本 0.0005 元/1k tokens（免费额度后），陪伴量级可忽略。
- **LLM 与 embedding 是两把独立的 key**：TDAI 的 extraction(L1)/persona(L3) 复用 AI4ALL 的 DeepSeek `api_key` + `base_url`；embedding 单独用百炼 DashScope key。DeepSeek 无 embedding 端点，二者本就在 config 中分属不同字段，不冲突。
- **故障可退化（已验证源码 `auto-recall.ts:searchHybrid`）**：hybrid 下 keyword(FTS) 与 embedding 并行、各自独立 try/catch。DashScope 超时/宕机时 embedding 腿返回空，FTS 腿照常出结果，本轮自动降级为关键词召回，不会整轮空；启动期 embedding 配置缺失则策略整体降级为 `keyword`。因此远程 embedding 是「锦上添花、坏了能退」的依赖，不是单点。
- ⚠️ **`@node-rs/jieba` 必须装上**：它服务 hybrid 里的 FTS 腿（中文分词），与是否用远程 embedding 无关；装不上则中文 FTS 退化为单字切分，召回明显变差。
- ⚠️ **隐私**：记忆文本会出到阿里云做 embedding；TDAI 写库前 `sanitize` 已剥离密码/验证码/证件号等敏感内容，但仍需业务侧确认可接受第三方云。
- 上线前一次性验证：百炼兼容模式 `/embeddings` 是否接受请求体 `dimensions` 字段（接受→`sendDimensions:true`，报 400→false）。
- 建议留一行 embedding token 计数日志/上限：embed 发生在 capture（后台、可批）+ recall（每轮），量级虽小但便于观测成本。
- TDAI pipeline 内部 L1/L2/L3 队列当前是进程内串行队列；单 sidecar 下已经天然限流。

## 7. 数据与一致性策略

### 7.1 近期：双系统并行

AI4ALL PostgreSQL/SQLite 仍是业务真相；TDAI store 是记忆增强缓存。

| 数据 | 权威系统 |
|---|---|
| 账号、绑定、计费、审核、消息 | AI4ALL DB |
| SOUL/IDENTITY/USER/MEMORY | AI4ALL `account_profile_files` |
| TDAI L0/L1/L2/L3 | TDAI store |
| TDAI recall 注入 | 本轮 prompt-only |

一致性要求：

- TDAI capture 失败不回滚主 turn。
- TDAI recall 失败不影响回复。
- AI4ALL wipe/unbind 需要后续补 TDAI 删除能力；PoC 阶段至少在运行手册中要求删除对应 data dir 或 TCVDB 记录。

### 7.2 后续：统一 PostgreSQL 的前提

如果要达成 Gemini 原方案里的“所有记忆落 PG”，需要在 TDAI 仓库新增 store backend：

```text
src/core/store/postgres.ts
```

它必须实现 `IMemoryStore`：

- `upsertL0` / `searchL0Vector` / `searchL0Fts` / `queryL0ForL1`
- `upsertL1` / `searchL1Vector` / `searchL1Fts` / `queryL1`
- `pullProfiles` / `syncProfiles` / `deleteProfiles`
- `getCapabilities`

AI4ALL 侧不能只靠 `database_url` 替 TDAI 完成这件事，因为 TDAI 进程是 Node.js，当前 store abstraction 与 AI4ALL `app/db/_backend.py` 没有关系。

## 8. 安全、隔离与降级

### 8.1 隔离红线

所有 AI4ALL -> TDAI 调用必须满足：

```text
tdai_session_key == "ai4all:" + account_id
```

⚠️ **这是必要条件，但当前 TDAI 下不充分**：`session_key` 只隔离 L0 和 pipeline 状态，L1/L2/L3 召回仍是 dataDir 全局（§1 结论修正）。真正守住隔离红线还需 §8.4 的 TDAI 多租户改造；在改造完成前，一个 sidecar 只能服务单账号。

日志中必须记录：

- `account_id`
- `tdai_session_key` hash 或原文的安全截断
- recall/capture status
- latency
- chars / memory_count

禁止：

- 禁止跨账号复用 recall 结果缓存。
- 禁止不带 `account_id` 查询 AI4ALL messages 后 seed。
- 禁止把 OpenClaw `channel_account_id` 当业务账号。

### 8.2 敏感信息

AI4ALL 已有 moderation 和 dreaming 敏感过滤。TDAI capture 前仍应保守：

- 同步审核拦截的入站内容不 capture。
- 图片理解失败 fallback 不 capture 图片内容猜测。
- 密码、验证码、token、证件、银行卡、精确地址和联系方式不应进入长期记忆。

TDAI 自身 extraction prompt 也有过滤，但 AI4ALL 不能只依赖下游。

### 8.3 失败降级

| 场景 | 行为 |
|---|---|
| `/health` 失败 | 标记 TDAI unavailable；主对话继续 |
| `/recall` 超时 | 不注入 TDAI block；metadata 记 `timeout` |
| `/capture` 失败 | 记录 warning；不影响用户回复 |
| Gateway 重启 | AI4ALL 自动重试下一轮；不补发本轮 capture，除非后续做 outbox |
| TDAI store 损坏 | 删除/恢复 TDAI data dir 后从 AI4ALL messages seed 重建 |

第一阶段不建议为 capture 建复杂 outbox；等 PoC 证明有效后再补。

### 8.4 TDAI 多租户改造（路 B，P1 前置）

经源码核实，TDAI standalone/sqlite store 是「单租户 per dataDir」：`session_key` 只隔离 L0 和 pipeline 状态，L1/L2/L3 召回是 dataDir 全局。要让一个 sidecar 安全服务多账号，需对 **TDAI 仓库**做以下改造（这是 TDAI 侧的开发量，AI4ALL 侧只消费结果）：

| # | 改造项 | 证据/落点 | 说明 |
|---|---|---|---|
| 1 | **L1 搜索按 session 过滤** | `searchL1Fts`/`searchL1Vector`/`searchL1Hybrid`（`store/types.ts:269-271`）签名无 session；SQL `sqlite.ts:635-641`（`l1_vec MATCH`）/`796-805`（`l1_fts MATCH`）无 WHERE；`auto-recall.ts:125`、`tdai-core.ts:290` 调用未传 | L1Record 已存 `session_key`（`store/types.ts:65`），**schema 无需改**；给上述接口加 `sessionKey` 参数、把过滤**下推**进 SQL/向量检索（`WHERE session_key = ?`），并沿 `executeMemorySearch → searchMemories → performAutoRecall` 全链路透传 |
| 2 | **L0 搜索按 session 过滤** | `searchL0Vector`/`searchL0Fts`（`store/types.ts:295-296`）签名无 session；conversation search 是**检索后再 filter**（`tools/conversation-search.ts:224-228`），`/search/conversations` 的 `session_key` 还是可选（`gateway/types.ts:83-87`） | 同 #1 下推；**post-filter ≠ pushdown**——先全库取 topK 再 filter，多租户下 topK 可能全是别账号、filter 完剩 0，召回质量塌。必须下推 + 多租户模式 `session_key` 必填 |
| 3 | **`/search/memories` 加 `session_key`** | `MemorySearchRequest`（`gateway/types.ts:66`）无字段；handler `server.ts:431` 未传 | 加字段（强校验）+ 透传到 #1 的过滤；`tdai_memory_search` 工具必带（§5.6） |
| 4 | **L2/L3 per-account** | persona 读 `pluginDataDir/persona.md`（`auto-recall.ts:148`）、scene 读 `readSceneIndex(pluginDataDir)`（`auto-recall.ts:162`），均 dataDir 根级 | 改为按 `session_key` 派生 per-account 子目录；写入侧（persona `persona-generator.ts:185` / scene writer）与读取侧同步改 |
| 5 | **后台 pipeline 多租户限流 + L3 原子写** | 每 session 一组 timer（L1 idle/L2 schedule，`pipeline-manager.ts:181-182,422`）+ 全局 L3 runner（`pipeline-manager.ts:956-1000`）；L3 是裸文件 RMW 无锁（`persona-generator.ts:185`）；开关只有全局 `extraction.enabled`（`config.ts:488`），无 per-tenant 开关，也无 per-session 手动触发 L2/L3 的 API（只有 `flushSession`=L1） | 结构式下后台 pipeline 会 ×N（见下成本修正）→ 需**跨 core 全局并发上限**；本地 L3/L2 改**原子写（temp+rename）**；明确「单 dataDir 单进程」契约。详见 §8.5 |
| 6 | **`/recall` response 补 `prependContext`** | 仅返回 `appendSystemContext`（`server.ts:385`），丢弃 L1 query-time 记忆（`auto-recall.ts:186-204`） | `RecallResponse` 加 `prepend_context` 字段返回 `result.prependContext`；**P0 前置**（§5.3） |

实现路线（两种满足方式，推荐结构式）：

- **结构式（推荐）**：Gateway 维护 `Map<session_key, TdaiCore>`，每账号一份独立 dataDir（`baseDir/{account}`），按需 lazy 实例化 + LRU 淘汰空闲账号。隔离是**结构性**的（各账号物理分库分文件），不依赖「每条 SQL 都记得加 WHERE」，天然覆盖 #1/#2/#4/#7（reindex/计数类），最契合「按账号隔离是核心不变量」。仍需做 #3/#6 的接口字段。
  - ⚠️ **成本修正（2026-06 核查）**：先前「单 core ≈ sqlite 句柄 + 小状态，可控」**低估了**。每账号一个 core = **一套后台 timer + 一个独立 `SerialQueue`**，N 个活跃账号可**并发 N 路 LLM 提纯**（各 core 的串行队列互不相干），造成 DeepSeek 并发/成本尖峰 + N 套常驻 timer 内存。结构式必须在 TDAI 侧配一个**跨 core 的全局并发上限/共享工作队列**（改造项 #5），否则活跃账号一多后台 LLM 打满。
- **过滤式**：单 TdaiCore + 共享 store，靠 #1/#2 的 `session_key` 过滤。内存省、后台 pipeline 被单一 `SerialQueue` 天然限到 concurrency=1，但「漏一个 WHERE 即跨账号泄漏」，与红线相悖，需配套强测试 + Gateway 层强制 `session_key` 放行。

无论哪种，#6（recall 补 `prependContext`）都必须做。最终内部实现由 TDAI 侧定，AI4ALL 只要求对外契约：`/recall`、`/search/*` 按 `session_key` 严格隔离且返回 query-time L1。

> 改造清单已抽成独立 issue 供 TDAI 团队推进：`docs/tech_design/tdai_multitenant_issue.md`。

wipe/unbind：账号硬删除路径 `unbind_and_wipe_account()` 需联动 TDAI namespace 清除——结构式下 = 删除该账号 dataDir（并卸载其 TdaiCore）；过滤式下 = 按 `session_key` 删 L1/L2/L3。**进入真实灰度前必须接通**，不能只靠手册删 data dir。

### 8.5 三条工程红线（结合 TDAI 源码核查）

外部评审提出三条工程红线，逐条核查后**全部成立**，但有三处机制判断需按 TDAI 当前实现纠正。

#### 红线 1：接管 pipeline 控制权（不放任原生后台）

- **成立**：TDAI 有后台常驻调度，非纯被动——每 session 一组 timer（L1 idle `l1IdleTimeoutSeconds` 默认 600s、L2 schedule `l2MaxIntervalSeconds` 默认 3600s，`pipeline-manager.ts:181-182,422`）、全局 L3 runner（`pipeline-manager.ts:956-1000`）、offload 5s poll + 24h reclaim（`offload/index.ts:946,1281`）。
- **纠正点**：开关粒度是**全局** `extraction.enabled`（`config.ts:488`、`tdai-core.ts:151`），关掉则整条 L0→L1→L2→L3 都不跑，**无 per-tenant 开关**；手动触发只暴露 `flushSession(sessionKey)`（=L1 flush，`/session/end`）与 `/capture`（按阈值/idle 触发 L1），**没有按 session 手动触发 L2/L3 的公开 API**。所以「自己调 API 触发该用户的 L1/L3 提纯」当前**只能做到 L1**。
- **对我们的结论**：结构式路线会把后台 pipeline ×N（§8.4 成本修正），是这条红线在多租户下的具象。优先方案 = **保留后台、但在 TDAI 侧加跨 core 全局并发上限**（改造项 #5）；若要完全接管算力（关 `extraction.enabled` + AI4ALL 按「聊满 N 句」自驱），前提是 TDAI 补 per-session L2/L3 触发 API，工程量更大，第一期不做。

#### 红线 2：暴力审计 SQL 与向量过滤

- **成立且范围更大**：除 L1 `searchL1Vector/Fts` 无过滤外，**L0 `searchL0Vector/Fts` 同样无过滤**（`store/types.ts:295-296`）；conversation search 是**检索后再 filter**（`tools/conversation-search.ts:224-228`）；`getAllL1Texts`/`rebuildFtsIndex`/`countL1` 等 reindex/统计类全跨 session。
- **纠正点**：**TDAI store 是 SQLite/tcvdb，不是 PG**，「开 PostgreSQL 慢查询日志审计」用错了对象。审计应落在：(a) 代码层逐条核对 `store/sqlite.ts` 的 SELECT/向量检索是否带 session；(b) SQLite trace / query log；(c) Gateway 层强制每个 search 请求必带 `session_key` 再放行（防御纵深）。
- **子要点**：**post-filter ≠ pushdown**。现状先全库取 topK 再 filter，多租户下 topK 可能全来自其他账号、filter 完剩 0，召回质量塌。必须把 session 过滤**下推进 SQL/向量检索**（§8.4 #1/#2），不是检索后过滤。

#### 红线 3：L3 画像读写一致性

- **成立且更脆**：L3 persona 是**磁盘文件 `persona.md`** 的裸 read-modify-write（`persona-generator.ts:185`，`fs.writeFile`，**无原子 rename、无锁、无 version**）；version 乐观锁只在 tcvdb 远程 sync（`tcvdb.ts:1117`），不保护本地文件。L2 scene 同样是无锁 `scene_blocks/*.md`。
- **纠正点**：「用 PostgreSQL 乐观锁 / version 字段」**不适用**——L3 既不在 PG 也不在任何 SQL 表，是文件。正解 = (a) 原子写（temp + rename）；(b) 同账号 L3 串行。
- **对我们的结论**：单进程内 TDAI 已用 `SerialQueue`（concurrency=1）全局串行 L1/L2/L3，故**单 sidecar 单进程下同账号 L3 不会自竞争**。竞争只在 (i) 同一 dataDir 被两个 sidecar 进程打开，或 (ii) P4 多实例扩容时复活。§4.2「用户硬绑定单节点 + 每节点单 sidecar」拓扑**天然规避** (i)(ii)。→ 当前拓扑**风险低**，但落一条硬约束：**禁止两个 sidecar 进程共享同一 dataDir**；P4 若上多实例/共享存储，必须补原子写或分布式锁。结构式额外好处：每账号独立 core+SerialQueue，跨账号 L3 本就串行隔离。

## 9. 分阶段实施

### P0：Sidecar 连通性 PoC

目标：不改主链路，确认 Gateway 可运行；**单账号**形态（多租户改造前，一个 sidecar 只服务测试账号）。

任务：

1. 本机启动 TDAI Gateway；装 `@node-rs/jieba`，配百炼 `TDAI_EMBEDDING_API_KEY`、`embedding.provider=dashscope`、`strategy=hybrid`（§6.2）。
2. 一次性验证：百炼兼容模式 `/embeddings` 是否接受 `dimensions` 字段 → 定 `sendDimensions`。
3. **TDAI 侧打 `/recall` 补丁（§8.4 #6）**：`RecallResponse` 补 `prepend_context`，否则 recall 拿不到 query-time L1，PoC 误判。
4. 写最小 `app/tdai_client.py`。
5. 加 health/recall/capture dry-run 测试。
6. 用固定 `aid_806382741` 手工 capture 几轮，再 recall。

验收：

- `GET /health` 返回 ok/degraded。
- `/capture` 返回 `l0_recorded > 0`。
- 多轮后 `/recall` 同时返回 `prepend_context`（L1 query 相关）和 persona/scene；hybrid 下 embedding 命中 > 0。
- 断开百炼（错 key）时 recall 自动退回 FTS、不报错整轮空。
- AI4ALL 不启动 TDAI 时测试仍绿。

### P0.5：TDAI 多租户改造（路 B，P1 前置，TDAI 侧）

目标：让一个 sidecar 能按账号安全隔离 L0/L1/L2/L3，解除「一个 sidecar 只能服务单账号」的约束。详见 §8.4。

任务（TDAI 仓库）：

1. 实现隔离（推荐结构式：per-account dataDir + `Map<session_key,TdaiCore>` lazy/LRU；或过滤式：L0/L1 搜索下推 `session_key` 过滤 + L2/L3 per-account 路径）。
2. `/search/memories` 加 `session_key` 字段并下推过滤（§8.4 #3）；`/search/conversations` 多租户模式 `session_key` 必填。
3. 提供 namespace wipe 能力（按 `session_key` 或删账号 dataDir），供 AI4ALL `unbind_and_wipe_account()` 联动。
4. 结构式下加**跨 core 全局并发上限**，限制同时进行的 LLM 提纯路数（§8.4 #5、§8.5 红线 1）。
5. 本地 L3/L2 写改**原子写（temp+rename）**；文档化「单 dataDir 单进程」契约（§8.5 红线 3）。

验收：

- 两个账号交叉 capture 后，A 的 `/recall`、`/search/memories`、`/search/conversations` 不返回 B 的 L0/L1/persona/scene。
- wipe 账号 A 后，A 的记忆全清，B 不受影响。
- 多账号同时活跃时后台并发 LLM 提纯有上限、不随账号数线性膨胀。

### P1：主对话灰度接入

目标：按账号 allowlist 在真实 turn 中启用 recall/capture（**依赖 P0.5 完成**，一个 sidecar 服务多个灰度账号）。

任务：

1. `build_turn_llm_input()` 调 recall 并注入 `tdai_recall_memories` + `tdai_recall_persona` 两个 block（§5.3）。
2. 回复成功后 best-effort 调 capture。
3. 在 tool registry 注册 `tdai_memory_search` / `tdai_conversation_search`，带 `ai4all:{account_id}`，每轮合计上限 3 次（§5.6）；`tdai_memory_search` 依赖 §8.4 #3。
4. 接通 `unbind_and_wipe_account()` → TDAI namespace wipe（§8.4）。
5. debug trace metadata 加 TDAI 字段。
6. 聚焦测试覆盖：
   - recall 成功注入 prompt（memories + persona 两块）。
   - recall 失败不影响 prompt。
   - capture 使用 `ai4all:{account_id}`。
   - search 工具命中正确账号，且每轮 3 次上限生效。
   - **跨账号隔离**：A 灰度账号的 recall/search 不返回 B 的记忆（依赖 P0.5）。
   - TDAI context 不写入 messages/daily notes。

验收：

- allowlist 账号可看到 TDAI recall 生效。
- 非 allowlist 账号行为逐字稳定。
- 多账号共享同一 sidecar 下召回严格不跨账号。
- TDAI Gateway 停止时主对话正常回复。

### P2：历史 seed 与质量评估

目标：让 TDAI 具备足够历史材料，并评估效果。

任务：

1. 新增 `scripts/seed_tdai_memory.py`。
2. 支持单账号 dry-run、limit、按日期过滤。
3. 输出 seed 行数、session 数、失败数。
4. 接 session-end / FastAPI shutdown flush（§5.5），确保 pipeline 退出前提纯。
5. 建立人工评估样例：
   - 用户偏好召回。
   - 过去事件追问。
   - 用户纠正旧记忆后是否以当前说法为准。

验收：

- 主要测试账号 seed 成功。
- 召回内容不跨账号。
- 错误/敏感记忆不过度注入。

### P3：与 Dreaming 的职责重划

目标：决定长期方向。

可选路径：

1. 保留 Dreaming 写 `USER.md/MEMORY.md`，TDAI 只做动态 recall。
2. Dreaming 继续做审计，但减少自动写入整文件。
3. TDAI 效果足够后，AI4ALL 自建 `account_memory_records/account_user_persona`，参考 `docs/plans/记忆机制_tdai化对齐.md`，逐步替代 sidecar。
4. 给 TDAI 增加 PostgreSQL backend，保留 TDAI pipeline。

### P4：共享存储与多节点

触发条件：

- TDAI 已进入核心体验。
- 多节点账号迁移频繁。
- 本地 sidecar SQLite 备份/迁移成本不可接受。

可选方案：

| 方案 | 优点 | 风险 |
|---|---|---|
| TCVDB backend | TDAI 已支持，向量能力完整 | 新增云服务和凭证运维 |
| 新增 TDAI PostgreSQL backend | 统一中心 PG，符合 AI4ALL 厚节点方向 | 需要改 TDAI TypeScript store，工作量较大 |
| AI4ALL 自建 L1/L3 | 完全贴合现有 Python/PG 架构 | 放弃一部分 TDAI 现成 pipeline |

> 中心 PG 已存在，PostgreSQL backend 在存储统一上最契合 AI4ALL 厚节点方向；但硬前置是 (a) 改 TDAI TypeScript store 实现 `IMemoryStore`（已知开发量）、(b) 中心 PG 装 `pgvector`（需实测，§13），并需接受 (c) 非 PG 节点（如节点 B）的 sidecar recall 每次跨内网连节点 A 的 PG——这与本地 SQLite recall 的低延迟相比是真实取舍。

## 10. 测试方案

### 10.1 文档阶段

本次只改文档，不运行代码测试。自审项：

- 方案不把不存在的 Python SDK 作为实施依赖。
- 方案不把 TDAI 当前不支持的 PostgreSQL backend 写成已可配置能力。
- 所有隔离描述都使用 AI4ALL `account_id`。
- 接入点与当前 `turn_service.py`、`PromptBuilder`、`memory_writer.py` 对齐。

### 10.2 实现阶段建议测试

聚焦测试：

```bash
.venv/bin/pytest tests/test_prompt_builder.py -v
.venv/bin/pytest tests/test_turn_service.py -v
```

新增测试建议：

```text
tests/test_tdai_client.py
tests/test_turn_tdai_memory.py
```

手工验证：

```bash
.venv/bin/uvicorn app.main:app --reload --port 8180
.venv/bin/python scripts/send_mock_turn.py --url http://127.0.0.1:8180 --text "hello"
.venv/bin/python scripts/check_prompt.py --url http://127.0.0.1:8180 --account aid_806382741
```

预期：

- TDAI disabled 时 prompt 不含 `tdai_recall_memories` / `tdai_recall_persona`。
- TDAI enabled 且 recall 有内容时 prompt metadata 记录两块 chars。
- messages 表只保存用户和助手可见文本。

## 11. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **多账号共享 sidecar 跨账号召回（blocker）** | L1/L2/L3 dataDir 全局，`session_key` 隔离不到，违反隔离红线 | P1 前置完成 §8.4 多租户改造（推荐结构式 per-account 物理隔离）；改造前一个 sidecar 只服务单账号；P1 测试含跨账号隔离用例 |
| **`/recall` 丢 `prependContext`** | 拿不到 query-time L1，PoC 误判召回无效 | P0 前置打 §8.4 #6 补丁，response 返回两段 |
| **结构式后台 pipeline ×N（成本）** | 活跃账号多时并发 N 路 LLM 提纯，DeepSeek 并发/成本尖峰 + N 套 timer 内存 | TDAI 侧加跨 core 全局并发上限/共享队列（§8.4 #5、§8.5 红线 1）；LRU 淘汰空闲 core |
| **L3 persona 文件并发覆盖** | 多进程/多实例下同账号 persona 丢更新 | 单 dataDir 单进程硬约束（§4.2 拓扑天然满足）；TDAI 侧改原子写；P4 多实例再上分布式锁（§8.5 红线 3） |
| **conversation/L0 搜索 post-filter 召回塌陷** | topK 全来自他账号、过滤后剩 0，召回质量差 | 把 session 过滤下推进检索而非检索后 filter（§8.4 #2、§8.5 红线 2） |
| TDAI Gateway API 仍在演进 | 接入代码可能跟随调整 | client 层封装，主链路只依赖内部接口 |
| sidecar SQLite 节点故障导致记忆丢失 | 该节点用户长期记忆暂失 | 微信绑定保证用户不漂移、本地记忆不分裂；中心 PG `messages` 可 re-seed 重建；仅频繁自由迁移时再升级 TCVDB/PG |
| 远程 embedding（百炼）超时/宕机 | 该轮丢失语义召回 | hybrid 并行、embedding 腿失败返空，自动退回 FTS 关键词召回（`auto-recall.ts:searchHybrid` 已验证）；`recallTimeoutMs` 短超时 |
| `@node-rs/jieba` 装不上 | 中文 FTS 退化为单字切分，召回变差 | 生产机预装并校验；纳入部署检查 |
| recall 延迟增加首 token 时间 | 微信回复变慢 | 1.2-1.5s 硬超时，失败跳过 |
| recall 内容污染长期记忆 | 错误记忆被二次写回 | prompt-only 注入，不写 messages/daily notes |
| TDAI extraction 产生敏感记忆 | 隐私风险 | capture 前过滤 + TDAI prompt + 后续 admin 观测 |
| 双记忆系统冲突 | prompt 里新旧记忆不一致 | 明确用户本轮优先；debug trace 记录来源 |
| 本地 data dir 未备份 | sidecar 记忆丢失 | 纳入备份；可从 AI4ALL messages seed 重建 |

## 12. 最小实现摘要

第一版只需要这些代码改动：

1. 新增 `app/tdai_client.py`。
2. `app/config.py` / `.env.example` 新增 TDAI 配置。
3. `app/turn_service.py`：
   - `build_turn_llm_input()` 中调用 recall，并通过 `PromptBuilder.extra_blocks` 注入。
   - 回复成功后 best-effort capture。
4. 新增 `tests/test_tdai_client.py` 和聚焦 turn 测试。
5. 可选新增 `scripts/seed_tdai_memory.py`。

第一版不改：

- 不改 `dreaming.py`。
- 不改 DB schema。
- 不改 `messages` 存储格式。
- 不改 OpenClaw bridge。
- 不引入 TDAI PostgreSQL backend。

## 13. 关键确认（2026-06）与遗留项

| # | 问题 | 结论 |
|---|---|---|
| 1 | 节点角色 | **已确认**：两节点都跑 AI4ALL app，节点 A 兼 PG。每节点各起一个 TDAI sidecar（§4.2）。 |
| 2 | pgvector 可用性 | **大概率可装，需实测**。仅在「托管 PG 扩展白名单不含 `vector` / 无 `CREATE EXTENSION` 权限 / PG 版本过低（需 11+，HNSW 需 pgvector 0.5+）/ 自建机无法装扩展二进制」时不可装。验证：`SELECT * FROM pg_available_extensions WHERE name='vector';`，或试 `CREATE EXTENSION vector;`。仅 P4 走 PG backend 时硬依赖；第一期 sidecar SQLite 不需要。 |
| 3 | TDAI 后台 LLM / embedding | **均已确认**。LLM 复用 DeepSeek `api_key`（覆盖 extraction/persona）；embedding 用阿里云百炼 `text-embedding-v3` 远程，`strategy=hybrid`（理由：轻量服务器 <3G 内存，本地模型有 OOM 风险；远程本机零内存、成本可忽略；hybrid 故障可退 FTS）。两把 key 独立（§6.2）。 |
| 4 | 故障策略 | **已确认（第一期）**：硬绑定 + 故障暂停，不做热备/重绑；DR 靠节点恢复后续用本地 SQLite 或从中心 PG re-seed（§4.2）。后续再评估热备。 |
| 5 | 多账号隔离模型 | **已确认（2026-06）**：走**路 B——改 TDAI 支持多租户**（§8.4），作为 P1 前置（P0.5）。`session_key` 仅隔离 L0/pipeline，L1/L2/L3 需 TDAI 侧改造；实现路线推荐结构式（per-account dataDir 物理隔离），过滤式为备选。改造前一个 sidecar 只服务单账号。 |
| 6 | `/recall` prependContext 补丁 | **已确认**：纳入 **P0 前置**。当前 `/recall` 只返回 `appendSystemContext`、丢弃 L1 query-time 记忆（`server.ts:385`）；P0 即在 TDAI 侧补 `prepend_context`，否则 PoC 误判（§5.3、§8.4 #6）。 |

遗留待定（不阻塞 P0，但阻塞 P1）：

- 路 B 实现路线终选（结构式 per-account dataDir vs 过滤式 session 下推）——由 TDAI 侧定，AI4ALL 只约束对外契约（§8.4）。

遗留待定（不阻塞 P0–P2）：

- 百炼兼容模式 `/embeddings` 是否接受请求体 `dimensions` 字段（接受→`sendDimensions:true`，报 400→false）；上线前一次性验证。
- `@node-rs/jieba` native 包在生产机的安装/兼容性（影响 hybrid 的 FTS 腿，装不上中文 FTS 退化为单字切分）。
- 记忆文本出第三方云（百炼）的隐私签字。
- pgvector 实测结果（决定 P4 是否走 PostgreSQL backend）。
