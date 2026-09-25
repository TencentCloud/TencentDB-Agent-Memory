# 新客户端二开适配指南

> **定位**：如果你要给 Memory Proxy 接入一个当前**未适配**的新 AI Agent 客户端（Aider / Cursor / 某新桌面 IDE / 自研 CLI / 某未来 harness），按本指南从"抓包摸底 → 列适配范围 → 20 步代码 → e2e 通过"一路做下来。已经实证过 5 家客户端（Claude Code / CodeBuddy / Codex / Workbuddy / dsh），把每次踩过的通用坑和适配点固化下来，避免下一个客户端再全部重踩一遍。
>
> **别偷懒跳步骤**——每一步都是从踩坑中抽出来的。遇到坑先查[§3 常见坑速查](#阶段-3-常见坑速查)。
>
> **参考实现**：dsh 是目前踩坑最完整的接入案例，代码全在本仓库内，见文末[参考实现：dsh（按功能分组）](#参考实现dsh按功能分组)一节——里面**按适配范围逐项**列出 dsh 是在哪一处改的，可以对着自己的客户端照抄。

---

## 阶段 0：抓包摸底（30–60 分钟，不改代码）

**为什么先抓包**：假设跨客户端等价 = 每次都踩坑。5 家客户端**每一家**的 body shape / session_id header / 元数据 wrapper / options 数量上限 / ask-user tool 名都不一样。**先摸清 5 处差异**再动代码。

### 0.1 抓 3–5 条真实请求

用 **mitmproxy**：

```bash
pip3 install --user mitmproxy    # 已装则跳
mitmdump -p 8888 -s /tmp/capture.py --set stream_large_bodies=100m
```

`/tmp/capture.py` 里的 addon 只做一件事：按 `user-agent` grep 出目标客户端的请求，把 request/response body 各存一份 JSON。把 grep 关键字换成新客户端指纹即可。

**关键**：Node ≥18 客户端要加 `NODE_OPTIONS='--use-env-proxy'` 才认 `HTTPS_PROXY`（undici 默认不认）。见[§3 坑 G](#坑-g抓包-node-22-https_proxy-无效)。

### 0.2 抓完对着 5 处差异填表

新建 `<client>-recon/` 目录（放本仓库外部或本地）存 fixture + 分析，按下表逐项对照：

| 维度 | 抓包看什么 |
|---|---|
| **body shape** | body 主字段 = `messages[]`（OpenAI/Anthropic）还是 `input[]`（OpenAI Responses）？用户文本在 `messages[i].content[j].text` 还是 `messages[i].content`（str）还是 `input[i].content[j].text`？ |
| **session_id header** | 有哪些 header，哪个是 sid？有没有 body 里的备份字段？ |
| **首帧元数据 role=user** | 数一下客户端在 `messages[]` 里塞几条 role=user，识别每条的稳定签名（如 `<system-reminder>` / runtime context / available_skills 等前缀）——只有真用户输入那条应该被 proxy 当"用户消息"处理，其它元数据条目要过滤 |
| **ask-user tool 名 + shape** | 找客户端源码 `packages/*/tool-ask-user/**` 或类似，拿 tool 名 + 参数 schema（必填字段 / snake vs camel case） |
| **options 数量上限** | 打开客户端 UI 源码搜 `options.length` / `maxOptions` / `slice`；无截断 = 不需要分页 |

**这 5 处差异决定后续代码改动**。漏一个都会踩坑。

### 0.3 判断需不需要 aux 短路

看客户端会不会发**独立类型请求**（compaction / title-gen / memgen 等）。判据：

- 有独立 endpoint 路径？（codex 有 `/responses/compact`，workbuddy 类似）
- 有独立 header？（dsh 有 `x-deepseek-harness-compact:1`）
- 靠 body 特征？（dsh title-gen 靠 tools 缺 + `thinking.disabled` + `max_tokens ≤ 128` + system prompt 前缀）

**任一有 aux 请求的客户端，adapter `classifyRequest` 必须能判**。CC/CB 全 main 无 aux，codex/workbuddy/dsh 都有。

---

## 阶段 1：适配范围一览（先明确要做什么）

Memory Proxy 对一个客户端**至少**做以下 10 件事。别一上来就 diff dsh、抄代码——**先对着下表勾一勾**：哪些能力**必须**在新客户端上跑起来，哪些**可选**，哪些**不适用**。列表勾完再进阶段 2 写代码，工作量心里有数。

| # | 适配能力 | 解决什么问题 | 必需? | 关联模块 |
|---|---|---|---|---|
| 1 | **路由 & 白名单** | 让 proxy 认识 `/<client>/<spaceId>/...` 这条路径、把 `<client>` 加进各种正则白名单，否则 auth 401 / 请求走 404 fall-through | ✅ 必需 | `MemoryProxy/src/server.ts`、`MemoryProxy/src/credit-reporter.ts` |
| 2 | **Session ID 解析** | 从客户端 header/body 里找出稳定的"会话唯一标识"，让同一次对话所有请求落到同一个 sessionKey；漏了 → 所有会话撞成同一个 key，session-init 状态错乱 | ✅ 必需 | `MemoryProxy/src/session/session-key.ts::resolveConversationId` |
| 3 | **请求分类（main / aux / headless）** | 区分"真用户对话"和"客户端后台辅助请求"（title-gen / compaction / memgen）；aux 必须**全部跳过** session-init / mem / injection / L0 / skill trigger，直接透传 | ✅ 必需 | `MemoryProxy/src/agent-adapters/<client>.ts::classifyRequest`、`MemoryProxy/src/handler.ts` 顶部 |
| 4 | **用户文本提取** | 从 body 里挑出"真用户输入"字符串（给 mem 命令识别 / L0 归档 / skill 抽取用），跳过元数据 role=user | ✅ 必需 | `MemoryProxy/src/agent-adapters/<client>.ts::extractUserText`、`MemoryProxy/src/session/store.ts::tryHistoryScan`、`MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` |
| 5 | **Session Init Form** | 首次对话弹一个 4 步表单让用户选 team / agent / task（`asset_confirm → team → agent → task`）；载体是客户端 preset 里挂的 `ask_user_question`（或同类）tool_call | ⚠️ 客户端有交互能力 = 必需；纯 CLI headless = 可选（走坑 C 的 bypass） | `MemoryProxy/src/session/<client>/form.ts`、`MemoryProxy/src/session/index.ts` dispatch、`MemoryProxy/src/session/codebuddy/init.ts` split-stage gate |
| 6 | **Header 预选（跳过 form）** | CI/CD / 自动化 / 无法响应 form 的客户端可以直接携带 `x-team-id` + `x-agent-id` + `x-task-id` + `x-conversation-id` header 一步注册 session；已通用支持，多数客户端**不用改代码** | ➖ 可选（已通用） | 无需改动，由 `MemoryProxy/src/session/registrar.ts` 通用处理 |
| 7 | **资产注入（Injection）** | 每轮主对话都在 system message 里塞 `<agent_skills>` / `<user_memory>` / `<session_context>` / `<tdai_profile_memory>` 等资产块，把团队记忆送到 LLM | ✅ 必需 | 用现成 `MemoryProxy/src/injection/adapters/{openai,anthropic}.ts`；若客户端 wire 有特殊字段（如 dsh `reasoning_content`）要加 metadata round-trip |
| 8 | **Wire 兼容 / 特殊字段透传** | 客户端可能硬校验某些非标字段必须往返带（dsh 的 `reasoning_content` / DeepSeek thinking chain），injection pipeline 的 parse→serialize 不能抹掉 | ⚠️ 客户端有特殊字段才需要 | `MemoryProxy/src/injection/adapters/openai.ts` 或 `anthropic.ts` 的 `parseMessage` / `serializeMessage` 用 `ContextMessage.metadata` 存 |
| 9 | **Mem 命令拦截** | 用户在对话里发 `mem:help` / `mem:sync` / `mem:create-skill` / `mem:session-reset` 时，proxy 拦截并返回短路响应（打开面板 / 刷新资产 / 触发抽取 / 重置状态），不走上游 LLM | ✅ 客户端有 form 能力时全部生效；headless bypass 客户端只支持部分 | `MemoryProxy/src/handler.ts` mem-command 段（通用，只要 `agentSource` 认得就自动生效） |
| 10 | **L0 归档 / Skill 抽取** | 主对话双向消息落 `tdai-recorder:write-l0`；对话超阈值或用户 force-archive 时触发 `skill/conversation/add` 让 core 抽 skill | ✅ 必需 | `MemoryProxy/src/handler.ts` 尾部（通用，只要 aux/headless 判据正确就自动生效） |
| 11 | **观测埋点 / Langfuse** | trace 带 `agent_source:<client>` tag、session-init 各阶段 log、tool_call 埋点，方便线上排查 | ✅ 必需（一行 tag，几乎零成本） | `agentAdapter.agentKind` 通用注入；确认 langfuse trace tag 里能看到新 `agent_source` |

**判定原则**：

- 一行"必需"的能力**全部做完**才能算基本可用
- "可选"的按客户端场景决定（CLI-only 客户端可以跳 5、9，只保留 6 header 预选）
- 客户端有独特的 wire 字段（如 DeepSeek 思维链）→ 8 号能力必做，否则上游 400
- 客户端会发 title-gen / compact 等 aux → 3 号能力必做，否则 aux 请求误弹 form / 误写 L0

**估工时**：一次完整适配（覆盖 1–11）在有实证 dsh 参考的前提下，抓包 + 编码 + 单测 + e2e 大约 3–4 个工作日；踩到未见过的坑另算。

---

## 阶段 2：代码改动（20 步 checklist，按顺序）

对着阶段 1 表格勾出来的能力，落到具体文件。每步都有对应的能力编号（能力 #1 = "路由 & 白名单"，以此类推）。

### 2.1 骨架 4 步（30 分钟）—— 对应能力 #1、#3、#4

| # | 文件 | 改动 | 对应能力 |
|---|---|---|---|
| 1 | `MemoryProxy/src/agent-adapters/<client>.ts` | 新建 —— `classifyRequest` 三重信号 + `extractUserText` | #3 #4 |
| 2 | `MemoryProxy/src/agent-adapters/types.ts` | `AgentKind` 联合加 `"<client>"` | #3 |
| 3 | `MemoryProxy/src/agent-adapters/index.ts` | factory switch 加 case | #3 |
| 4 | `MemoryProxy/src/server.ts` | 加 9 条路由（带/不带 `v1` × 主端点/aux/cost-guard/analyse marker），对照 dsh 段抄 | #1 |

### 2.2 白名单 & Session 识别 3 步 —— 对应能力 #1、#2、#7

| # | 文件 | 改动 | 对应能力 |
|---|---|---|---|
| 5 | `MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | 正则加 `\|<client>` —— **漏了会返 auth 401 `missing service_id`** | #1 |
| 6 | `MemoryProxy/src/session/session-key.ts::resolveConversationId` | header fallback 链加客户端专属 session header | #2 |
| 7 | 无独立 profile 需要时跳过；有的话 `MemoryProxy/src/injection/agents/<client>/*` 一套（参考 `MemoryProxy/src/injection/agents/workbuddy/`） | #7 |

### 2.3 Session Init Form 载体 4 步 —— 对应能力 #5

| # | 文件 | 改动 | 对应能力 |
|---|---|---|---|
| 8 | `MemoryProxy/src/session/<client>/form.ts` | 新建 —— tool 名 / 参数 shape 完全按客户端 preset 定，别复用别家 | #5 |
| 9 | `MemoryProxy/src/session/index.ts` | 加 dispatch 分支（参考 workbuddy 那段：CB 状态机产 `formData` 后外层重渲染） | #5 |
| 10 | `MemoryProxy/src/session/codebuddy/init.ts` split-stage gate | 5 处 gate 加 `\|\| agentSource === "<client>"` —— 漏了会一次同问 agent+task 直接 bypass | #5 |
| 11 | `MemoryProxy/src/session/codebuddy/cleaner.ts` `tool_call_id` 正则 | 加 `\|<client>_` 前缀识别 | #5 |

### 2.4 元数据过滤 & Wire 兼容 3 步 —— 对应能力 #4、#8

| # | 文件 | 改动 | 对应能力 |
|---|---|---|---|
| 12 | `MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation` | 按客户端首帧元数据签名跳过 user 计数 —— 漏了会误判"有历史"直接 skip session-init | #4 |
| 13 | `MemoryProxy/src/session/store.ts::tryHistoryScan` | 同款过滤逻辑 | #4 |
| 14 | wire 特殊字段 round-trip（如 dsh 的 `reasoning_content`） —— `MemoryProxy/src/injection/adapters/openai.ts` 或 `anthropic.ts` 的 parse/serialize 用 metadata 保留；必须用 debug env 双向 body dump 对比验证 | #8 |

### 2.5 Handler 短路 2 步 —— 对应能力 #3、#5、#9、#10

| # | 文件 | 改动 | 对应能力 |
|---|---|---|---|
| 15 | `MemoryProxy/src/handler.ts` 顶部 | 调 `agentAdapter.classifyRequest(body, path, headers)` 分类；`isAuxiliary=true` 时 session-init / mem / injection / L0 / skill trigger **全部跳过**，直接透传 | #3 #9 #10 |
| 16 | `MemoryProxy/src/handler.ts` 顶部 | 若客户端有 CLI headless 场景（preset 少 tools 里无 ask-user），加类似 dsh 的 `_headless` 判据，同 aux 一样跳过 form；mem 命令给出提示或降级到 header 预选 | #5 #9 |

### 2.6 测试 & 验证 4 步 —— 对应能力 #5、#9、#10、#11

| # | 内容 | 对应能力 |
|---|---|---|
| 17 | 单测：adapter `classifyRequest` + form builder shape + real-capture fixture 端到端 —— 落到 `MemoryProxy/src/__tests__/agent-adapters/<client>.test.ts` + `MemoryProxy/src/session/<client>/__tests__/form.test.ts` | #3 #5 |
| 18 | curl smoke：直接打 `/<client>/default/*` 触发 form，验证 session-init 三态转移（`asset_confirm → team → agent → task`） | #5 |
| 19 | web e2e（推荐 playwright）：**真跑一遍客户端 web UI**（session-init 4 步 + 1 轮真对话，验证注入 + 归档 + langfuse trace） | #5 #7 #10 #11 |
| 20 | mem / L0 / skill 端到端：已初始化 session 里发 `mem:help` / `mem:sync` / `mem:create-skill` / 长对话触发 skill 提取 / grep proxy log 验 L0 写入 | #9 #10 |

---

## 阶段 3：常见坑速查

前 5 家客户端每一家都踩过至少 3 个坑。**先查这里再自己 debug**。

### 坑 A：`missing service_id (spaceId not in request path)` 401

**根因**：`credit-reporter.ts::extractSpaceIdFromPath` 白名单正则没含新客户端名。

**修**：加进 `^(claude-code|codebuddy|codex|cursor|hermes|openclaw|workbuddy|dsh|<new-client>)$`。

### 坑 B：session-init form 弹了 / 或者永远不弹

- **永远不弹** = `resolveConversationId` fallback 没识别客户端 session header → sessionKey 落到 keyId 兜底，或者 `isFreshCBConversation` 把首帧元数据 user 当"有历史" → 走 markerless bypass。
  - 修 `session-key.ts` fallback 链 + `codebuddy/init.ts::isFreshCBConversation` + `store.ts::tryHistoryScan` 加元数据签名过滤
- **弹了但选完 agent 没弹 task** = split-stage gate 没加新客户端 → 走 CB 老一次同问 pending_agent_task → task 空直接 bypass。
  - 修 `codebuddy/init.ts` 5 处 gate 加 `|| agentSource === "<client>"`
- **翻页无限循环 / default 任务每页开头都出现** = 沿用了 CC 的 4-per-page 分页但没写 MORE 拦截。
  - 修：客户端 UI 无 options 上限时**直接关掉分页，全量渲染**（dsh 就走这条）

### 坑 C：上游 400 `unknown tool ""`

**根因**：客户端 preset 没挂 `ask_user_question`（或本客户端的 UI tool），proxy 塞的 fake `tool_call` 校验拒。

**修**：加 headless bypass —— `body.tools` 非空但无该 tool 时，直接透传不弹 form。

### 坑 D：上游 400 `The reasoning_content in the thinking mode must be passed back to the API`

**根因**（两个坑一起踩）：

1. fake session-init assistant 消息不带 `reasoning_content` 字段
2. 塞了空串 `""` → 客户端 translate.ts 用 `length > 0` 判据吃掉

**修**：fake response 塞**非空**占位串（如 `[proxy session-init form]`）。

**次生坑**：塞了非空占位，客户端也 replay 回 proxy 了，但**injection pipeline parse→serialize 抹了字段**。

- 用 `PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY` 两个 env 抓入站/出站 body 对比。
- 修 `MemoryProxy/src/injection/adapters/openai.ts` / `anthropic.ts` 的 `parseMessage`/`serializeMessage`，用 `ContextMessage.metadata` 存透传字段。

### 坑 E：aux 请求（compaction / title）误走 session-init 弹 form

**根因**：`handler.ts` 顶部没 `classifyRequest`，所有请求全当 main。

**修**：`handler.ts` 顶部调 `agentAdapter.classifyRequest(body, path, headers)`，`isAuxiliary=true` 时 session-init / mem / injection / L0 / skill trigger **全部跳过**。

### 坑 F：客户端特色 wire 字段（如 `reasoning_content`）round-trip 丢失

见坑 D 次生坑。**通用做法**：`PROXY_DEBUG_DUMP_INBOUND` + `PROXY_DEBUG_DUMP_BODY` 对比入站/出站字段，任一丢失就补 adapter。

### 坑 G：抓包 Node 22 HTTPS_PROXY 无效

**修**：加 `NODE_OPTIONS='--use-env-proxy'`。undici experimental，但目前唯一手段。

### 坑 H：用 headless 抓包，以为 tool 不存在

**教训**：preset 系统决定 tools，不同 profile 挂的 tool 差异是常态。**web / tui 场景的 tools 数组一定比 headless 全**。抓包最好抓 web，或者两种都抓一次。

---

## 完成标准

以下**全部**验证过才算适配完成（左侧标注对应的能力编号）：

| 能力 | 完成标准 |
|---|---|
| #1 路由 | `curl -X POST /<client>/default/chat/completions` 不返 404、不返 401 `missing service_id` |
| #2 sessionKey | 同一 session_id 的多次请求在 proxy log 里 `sessionKey=` 一致 |
| #3 请求分类 | aux 请求（compaction / title-gen）proxy log 显示 `[request-classify] → auxiliary (skip ...)` 直接透传 |
| #5 Session Init | 首帧返 form（role=assistant + `tool_call` 是客户端 preset 的 ask-user tool 名）；playwright 走完 `asset_confirm → team → agent → task` 4 步 |
| #7 注入 | 主对话上游返 200，且上游看到的 system message 里含 `<agent_skills>` / `<user_memory>` 等资产块 |
| #8 wire 兼容 | 主对话上游 **不返** 400（`reasoning_content` / `unknown tool` / `invalid_request_error`） |
| #9 mem 命令 | `mem:help` / `mem:sync` / `mem:create-skill` 三命令拦截返短路响应 |
| #10 L0 & skill | proxy log 有 `tdai-recorder:write-l0` 表示 L0 落盘；有 `[skill-conversation-add] archived reason=tool_calls` 表示 skill 提取触发 |
| #11 观测 | Langfuse trace 带 `agent_source:<client>` tag |
| — 单测 | `npx vitest run src/session/<client> src/__tests__/agent-adapters/<client>.test.ts` 全绿 |
| — 全量测试 | `npx vitest run` 零回归 |

---

## 参考实现：dsh（按功能分组）

dsh 是**目前踩坑最多、覆盖最完整**的接入案例。下表按[阶段 1 适配范围](#阶段-1适配范围一览先明确要做什么)的能力编号，列出 dsh **每项能力对应的代码位置**，可直接对着自己的客户端照抄改名。

| 能力 | dsh 实现位置 | 说明 |
|---|---|---|
| #1 路由 & 白名单 | `MemoryProxy/src/server.ts` dsh 段（9 条路由）<br>`MemoryProxy/src/credit-reporter.ts::extractSpaceIdFromPath` | 主 `/chat/completions` × (带/不带 v1) × (main/aux/cost-guard/analyse marker) 组合 |
| #2 Session ID 解析 | `MemoryProxy/src/session/session-key.ts::resolveConversationId`（`x-deepseek-harness-session-id` fallback） | dsh 只从 header 拿 sid，body 没 fallback |
| #3 请求分类 | `MemoryProxy/src/agent-adapters/dsh.ts::classifyRequest`<br>`MemoryProxy/src/handler.ts` 顶部 aux short-circuit | 三重信号：compact header > title body-shape > main |
| #4 用户文本 & 元数据过滤 | `MemoryProxy/src/agent-adapters/dsh.ts::extractUserText`<br>`MemoryProxy/src/session/codebuddy/init.ts::isFreshCBConversation`<br>`MemoryProxy/src/session/store.ts::tryHistoryScan` | dsh 首帧塞 3 条元数据 role=user，签名匹配跳过 |
| #5 Session Init Form | `MemoryProxy/src/session/dsh/form.ts`（tool = `ask_user_question`，call_id 前缀 `call_dsh_session_init_`）<br>`MemoryProxy/src/session/index.ts` dsh dispatch 分支<br>`MemoryProxy/src/session/codebuddy/init.ts` 5 处 split-stage gate 加 `agentSource === "dsh"`<br>`MemoryProxy/src/session/codebuddy/cleaner.ts` `tool_call_id` 正则加 `dsh_` 前缀 | 状态机复用 CB，dsh UI 无 options 上限所以**不分页** |
| #7 注入 | 复用 `MemoryProxy/src/injection/adapters/openai.ts`（无独立 profile） | dsh 是标准 OpenAI Chat，注入模板走 CB 那一套 |
| #8 Wire 兼容 | `MemoryProxy/src/injection/adapters/openai.ts::parseMessage`/`serializeMessage`（`reasoning_content` 用 `ContextMessage.metadata` 保留） | DeepSeek thinking chain 硬校验必须往返带 |
| #9 Mem 命令 | 通用 mem-command 段自动生效；仅在 dsh headless 时降级（`handler.ts::_dshHeadless` 判据） | headless bypass 客户端 `mem:session-reset` 有专门的降级提示 |
| #10 L0 & Skill | 通用 handler 尾部自动生效；`_dshHeadless` 时跳过（`handler.ts` 相关 `if !_dshHeadless`） | aux 判据正确后无需 dsh 特殊处理 |
| #11 观测 | `agentAdapter.agentKind = "dsh"` 通用注入到 langfuse trace tag | 无需额外埋点代码 |
| — Headless Bypass（dsh 独有能力） | `MemoryProxy/src/handler.ts::_dshHeadless`（`body.tools` 非空但无 `ask_user_question` → bypass） | dsh CLI 场景无 preset，全流程跳过 form / mem / injection |
| — 单测（39 个，最完整 fixture 集） | `MemoryProxy/src/__tests__/agent-adapters/dsh.test.ts`（19 adapter tests）<br>`MemoryProxy/src/session/dsh/__tests__/form.test.ts`（17 form tests）<br>`MemoryProxy/src/injection/adapters/__tests__/openai.test.ts`（3 openai round-trip tests） | 照抄改客户端名基本能用 |

对外配置文档（用户视角的 baseURL / 配置文件 / session-init 交互流程）见 [`agents/dsh/README.md`](./dsh/README.md)。
