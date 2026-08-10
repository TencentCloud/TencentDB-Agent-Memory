# TencentDB Agent Memory v2.0.0 —— LLM 依赖穷尽式分析

> 仓库：`D:\repos\TencentDB-Agent-Memory`（腾讯 TencentDB Agent Memory，v2.0.0，CHANGELOG.md 确认 2026-08-03）
> 核心问题：**若整个系统在不配置任何 LLM（无 API key、无模型）的情况下运行，哪些功能失效、哪些仍可工作、改造点在哪里？**
> 方法：逐文件静态分析，所有结论均带 `文件路径:行号` 引用。路径均相对仓库根目录。

---

## 0. 结论速览（TL;DR）

| 模块 | 是否本地调用 LLM 做推理 | 无 LLM 时的行为 |
|---|---|---|
| MemoryKnowledge | **是**（仅 Wiki 摄入/合并/概览/摘要链路） | Wiki 构建硬失败（fail loudly）；CodeGraph 构建与全部检索（BM25/FTS/图多跳）**完全不需要 LLM，照常工作** |
| MemoryProxy | **否**（纯转发层，从不做推理） | 正常启动；转发请求在请求时才失败。sessionInit/注入/抽取/写侧全部**无 LLM** |
| MemoryPanel | **否**（无状态 CRUD + 反代） | 正常工作；唯一 LLM 相关动作是向 KS 推送 llm_binding **配置**（非推理） |
| sdk/memory-core | **否**（零 LLM 依赖） | 正常工作；`Transport` 接口可注入 mock |
| deploy | 配置层强制 | **start-all.sh 的 require_vars 硬失败**，三件套拒绝启动——这是"无 LLM 运行"的最大阻断点 |

**一句话**：系统里真正消耗 LLM 的只有 MemoryKnowledge 的 Wiki 摄入链路；其余模块要么纯转发、要么纯检索、要么纯 CRUD。真正阻止"零 LLM 启动"的是 deploy 脚本的强制校验，而非代码本身。

---

## 1. MemoryKnowledge（知识服务 KS）

### 1.1 Wiki 摄入：两阶段 LLM，硬依赖

Wiki ingest 是 KS 中唯一真正调用 LLM 做推理的链路，且为"两阶段"设计（先分析、再生成 FILE 块），缺 key 即抛错。

- **LLM 客户端工厂** `MemoryKnowledge/src/engines/wiki/ingest-v2/llm.ts:88`（`createLlmClient`）
  - `llm.ts:90-95`：`apiKey` 缺失 → `throw`，文案明确："LLM apiKey 未配置：proxy 模式需 TMC 为该 service_id 推送 llm_binding；或设 LLM_MODE=custom + LLM_API_KEY 走自带端点"。
  - `llm.ts:96-101`：`baseUrl` 缺失 → `throw`。
  - `llm.ts:104-106`：按 `protocol` 选 `createAnthropic` / `createOpenAI`（Vercel AI SDK）。
  - `llm.ts:80-83`：`LlmClient` 接口（`chat` + `config`），注释"便于测试时打桩"——**这是注入空实现的天然改造点**。

- **摄入主流程** `MemoryKnowledge/src/engines/wiki/ingest-v2/index.ts:75-209`（`ingestSource`）
  - `index.ts:86`：`const llm = options.llm ?? createLlmClient(llmConfig)` —— 允许外部注入 `llm`，否则现造。
  - `index.ts:118-122`：**阶段 A 分析** `llm.chat`。
  - `index.ts:132`：**阶段 B 生成** `llm.chat`（默认两阶段）。
  - `index.ts:136`：单阶段 generate 分支（亦走 `llm.chat`）。
  - `index.ts:139`：`parseFileBlocks(out)` 解析 LLM 输出的 FILE 块——纯字符串解析，无 LLM。
  - `index.ts:156-158`：零有效页面 → 抛错。
  - `index.ts:169`：调用 `mergePage`。
  - `index.ts:285-310`：`canonicalizePagePath`——纯路径规范化，无 LLM。

- **合并** `MemoryKnowledge/src/engines/wiki/ingest-v2/merge.ts:70-109`（`mergePage`）
  - `merge.ts:91`：`isCandidateRedundant` 规则判重 → 命中即**跳过 LLM**（说明合并并非必然调 LLM）。
  - `merge.ts:147`：`rewriteMerge` LLM 调用，label `merge-rewrite`。
  - `merge.ts:178`：`appendMerge` LLM 调用，label `merge-append`。
  - `merge.ts:111-118` / `merge.ts:120-127`：`MERGE_SYSTEM` / `APPEND_SYSTEM` 提示词。

- **概览** `MemoryKnowledge/src/engines/wiki/ingest-v2/overview.ts:86-112`（`generateOverview`）
  - `overview.ts:99`：LLM 调用，label `overview`。
  - `overview.ts:73-79`：`OVERVIEW_SYSTEM` 提示词。
  - 增量摄入也会为 overview 造 LLM 客户端：`MemoryKnowledge/src/engines/wiki/manager.ts:582-584`（`runIngestIncremental` 内 `createLlmClient`）。

- **Wiki 摘要回调** `MemoryKnowledge/src/callback.ts:82-121`（`generateWikiSummary`）
  - `callback.ts:106`：`createLlmClient`；`callback.ts:107-113`：`chat`。
  - **关键容错**：失败时返回 `""`（不抛错），即摘要失败不阻断构建主流程。

- **构建失败传播** `MemoryKnowledge/src/store/wiki-service.ts`
  - `wiki-service.ts:269-287`：`ingest` 入口。
  - `wiki-service.ts:1010`：`runBuild`；`wiki-service.ts:1059`：异常时置 status=`failed`。
  - `wiki-service.ts:1090-1095`：调 `generateWikiSummary`（配 `resolveLlm`）。

### 1.2 LLM 配置解析：proxy 模式"无绑定即失败"

- `MemoryKnowledge/src/config.ts:75-95`（`loadConfig`）：读 `LLM_MODE`（默认 `proxy`，`config.ts:85`）、`LLM_PROTOCOL/PROVIDER/API_KEY/MODEL/BASE_URL`（`config.ts:86-90`）；`LlmConfig` 接口 `config.ts:19-39`。
- `MemoryKnowledge/src/store/llm-binding-store.ts:146-185`（`resolveLlmConfig`）：**无绑定且 LLM_MODE=proxy 时返回空的 baseUrl/apiKey**，使下游 `createLlmClient` 抛错——即"fail loudly"，而非静默降级。

### 1.3 CodeGraph 构建：不需要 LLM

- `MemoryKnowledge/src/engines/code/bridge.ts:106-134`（`indexProject`）：封装 `@colbymchenry/codegraph`，**纯静态分析，无 LLM 调用**。
- `MemoryKnowledge/src/store/code-graph-service.ts:370`：注释明示 "Generate summary via template (no LLM for code-graph)"——摘要走模板。
- `MemoryKnowledge/src/callback.ts:127-136`（`generateCodeGraphSummary`）：纯模板拼接，**无 LLM**。

### 1.4 检索：BM25 / FTS / 图多跳，全部不需要 LLM

- `MemoryKnowledge/src/engines/wiki/manager.ts:291-325`（`tokenize`）：本地分词。
- `MemoryKnowledge/src/engines/wiki/manager.ts:332-342`（`ftsSearch`）：SQLite FTS5，SQL 用 `bm25(wiki_fts, 5.0, 1.0)`（`manager.ts:338`）。
- `MemoryKnowledge/src/engines/wiki/index-db.ts:76`：FTS5 虚表定义。
- `MemoryKnowledge/src/engines/wiki/graph-search.ts:40-91`（`graphMultiHopSearch`）：基于 `[[wikilink]]` 边的 BFS 多跳，**无 LLM**。
- **向量/embedding 检索在 KS 中实际缺位**——检索面只有 BM25/FTS + 图，embedding 不在 KS 侧实现（对比 sdk 的 `SkillSearchMode`，见 §4）。

### 1.5 配置样例与容器

- `MemoryKnowledge/.env.example:16`：注释 "LLM 配置（wiki ingest 必需，code-graph 不依赖）"。
- `MemoryKnowledge/docker-compose.yml`：`--llm-mode=${LLM_MODE:-proxy}`、`--llm-key=${LLM_API_KEY:-}` 等——默认 proxy 模式不要求本地 `LLM_API_KEY`（依赖 context_proxy 推送绑定）。

### 1.6 MemoryKnowledge 小结

- **需要 LLM（无 key 即失效）**：Wiki 摄入（分析+生成两阶段）、页面合并（rewrite/append）、概览生成、Wiki 摘要。
- **不需要 LLM（照常工作）**：CodeGraph 构建、CodeGraph 摘要、BM25/FTS 检索、图多跳检索、分词、路径规范化、FILE 块解析。
- **改造点**：
  1. `llm.ts:80-83` 的 `LlmClient` 接口 + `index.ts:86` 的 `options.llm ??` 注入点 → 可注入 no-op/离线实现，让摄入跳过 LLM 阶段（退化为仅解析/入库）。
  2. `llm.ts:90-101` 的 throw 改为降级（返回空实现）即可让 Wiki 构建"降级但不失败"。
  3. `callback.ts` 摘要已具备"失败返回空串"的容错，可作参照。

---

## 2. MemoryProxy（上下文代理）

### 2.1 定位：纯转发层，自身从不做 LLM 推理

MemoryProxy 是一个 OpenAI `/v1/chat/completions` + Anthropic `/v1/messages` 双协议的**透明转发代理**。它把请求改写后转发给上游 LLM，自身不生成 token。

- 路由注册 `MemoryProxy/src/server.ts`：`/v1/messages` → anthropicHandler；catch-all `POST /*` → `handleChatCompletions`。
- OpenAI 协议转发 `MemoryProxy/src/handler.ts`：`resolveForwardTarget`（`handler.ts:912`）→ `forwardWithRetry`（`handler.ts:293`）→ `fetch(target.url)`（`handler.ts:347`）。
- Anthropic 协议转发 `MemoryProxy/src/anthropicHandler.ts:1039`：同样走 `resolveForwardTarget`。

### 2.2 上游 LLM 配置

- `MemoryProxy/src/config.ts:7`（`DEFAULT_UPSTREAM`）、`config.ts:273-279`（`upstream.url/apiKey/agents`）、`config.ts:240-255`（`parseUpstreamAgents`）：上游 url/key + 多模型 agents 回退表。
- `MemoryProxy/config.example.yaml`：`upstream.agents` 多模型回退、双协议、injection / extraction / sessionInit / tdai / skill / knowledge / costGuard / creditPricing 各节。

### 2.3 Cost Guard：私有子模块，空则直通降级

- `MemoryProxy/src/guard-adapter.ts:106-115`：对 cost-guard 做 **动态 import**；`guard-adapter.ts:341-382`（`resolveForwardTarget`）、`guard-adapter.ts:259-268`（`buildPassthroughTarget`）、`guard-adapter.ts:234-257`（`joinUrl`）。
- **子模块为空**：`MemoryProxy/packages/cost-guard` 目录未初始化 → 动态 import 失败 → **静默回退 passthrough（直通）**。这是全仓库唯一 import cost-guard 之处。
- 结论：Cost Guard 属"可选增强"，缺失不阻断转发。

### 2.4 sessionInit / 注入 / 抽取 / 写侧：全部无 LLM

- **sessionInit 假表单**：`MemoryProxy/src/session/form.ts` —— 本地构造 OpenAI 兼容的 tool_call 假响应，**不请求上游 LLM**。
- **会话上下文注入**：`MemoryProxy/src/session/context-injector.ts:106-122`（`injectSessionContext`）、`context-injector.ts:246-264`（`injectSessionContextIntoAnthropicSystem`）——注入 `<session_context>` 块，**纯字符串操作**。
- **注入管线**：`MemoryProxy/src/injection/pipeline.ts:80-147`（`InjectionPipeline.process`）：parse → inject hooks → serialize；各 injector 产出的是**经 HTTP 拉取的静态文本块**，无 LLM。
- **skill 抽取触发**：`MemoryProxy/src/skill/handler-glue.ts:70`（`triggerSkillExtractIfReady`）——把会话转发给 core 的 `/v3/skill/conversation/add`，**proxy 本地不跑 LLM 抽取**。
- **tdai 记录**：`MemoryProxy/src/tdai/recorder.ts:32`（`recordTdaiTurn`）——写 L0，**无 LLM**。
- sessionInit 默认关闭：`MemoryProxy/src/config.ts:88-102`。

### 2.5 启动连通性探测：非阻断

- `MemoryProxy/src/connectivity.ts:11-65`（`checkConnectivity`）：启动时对上游 LLM 等做探测，但为 fire-and-forget **不阻塞启动**。

### 2.6 MemoryProxy 小结

- **需要 LLM（无上游时失效）**：真正的"推理转发"——即客户端经此代理向 LLM 发推理请求。无上游时这类请求在**请求时**失败（连接/转发错误），但服务本身能启动。
- **不需要 LLM（照常工作）**：服务启动、sessionInit 假表单、上下文/知识注入、tdai 记录、skill 抽取触发（转发）、Cost Guard 直通降级。
- **改造点**：Proxy 本就"无 LLM 也能起"。若要完全离线，只需把 `upstream` 置空/不配置，并让调用方不发起推理请求即可；无需改代码。`connectivity.ts` 探测已是非阻断，无需处理。

---

## 3. MemoryPanel（控制台）

### 3.1 定位：无状态 CRUD + 反向代理

- `MemoryPanel/README.md`：明示"无状态"控制台，不落本地数据。
- `MemoryPanel/src/panel/http/routes/knowledge/wiki-routes.ts`：对 KS `/v3/wiki/*` 做反代（stateless）。

### 3.2 唯一 LLM 相关动作：推送 llm_binding 配置（非推理）

- `MemoryPanel/src/panel/startup/ensure-knowledge-llm-binding.ts:87-161`（`ensureKnowledgeLlmBinding`）、`:164`（`ensureKnowledgeLlmBindings`）：为 KS 铸造 user_key、推送 `proxy_base_url` 等 **LLM 绑定配置**。
  - 这是**配置下发动作，不是 LLM 推理调用**。
  - best-effort：失败不阻断启动。
- `MemoryPanel/.env.example:43`：`KNOWLEDGE_LLM_BINDING_SYNC=true`；`:45`：`KNOWLEDGE_LLM_PROXY_BASE_URL`。

### 3.3 MemoryPanel 小结

- **需要 LLM**：无。Panel 自身从不推理。
- **不需要 LLM（照常工作）**：全部 CRUD、资产预览、对 KS/Proxy 的反代、启动。
- **改造点**：无需改造。若 KS 侧无 LLM，Panel 上"触发 Wiki 构建"类操作会因 KS 端 fail loudly 而返回失败状态，但 Panel 本身不崩溃。

---

## 4. sdk/memory-core

### 4.1 零 LLM 依赖；Transport 可注入

- `sdk/memory-core/typescript/src/client.ts:8-19`（`MemoryClientConfig`）：仅 endpoint/apiKey/serviceId/timeout/rejectUnauthorized，**无 LLM 字段**。
- `sdk/memory-core/typescript/src/client.ts:24-26`（`Transport` 接口）：注释 "for testing — inject a mock that satisfies this"——**天然支持注入 mock，是离线/测试改造点**。
- `sdk/memory-core/typescript/src/v3/http.ts:8`（`V3HttpTransport`）：严格 HTTP，无 LLM。

### 4.2 检索模式与 LLM 错误码

- `sdk/memory-core/typescript/src/v3/skill-types.ts:144`（`SkillSearchMode`）：`bm25 | embedding | hybrid`——检索模式枚举。embedding/hybrid 的实现在**服务端**，SDK 只是声明。
- `sdk/memory-core/typescript/src/v3/skill-types.ts:421`：错误码 `LLM_UNAVAILABLE: 50302`——SDK 已预定义"LLM 不可用"错误，说明系统设计上承认 LLM 可缺位。

### 4.3 （对照）服务端 LLM 入口

- `MemoryCore/src/adapters/standalone/llm-runner.ts:286`（`createOpenAI`）、`:321`（`generateText`）：StandaloneLLMRunner，服务端抽取/写侧用。
- `MemoryCore/src/gateway/llm-resolver.ts:42`（`resolveEffectiveLlmConfig`）、`:105`（`validateLlmProviderConfig`）：支持 `provider="proxy"` 模式。

### 4.4 sdk 小结

- **需要 LLM**：无。SDK 纯 HTTP 客户端。
- **不需要 LLM（照常工作）**：全部 v3 API 调用、BM25 检索。embedding/hybrid 检索是否可用取决于服务端是否配置了 embedding，与 SDK 无关。
- **改造点**：`client.ts:24-26` 的 `Transport` 注入口即可完全离线打桩。

---

## 5. deploy + INSTALL/README

### 5.1 两套 LLM 参数（.env）

`deploy/global-images/.env.example`：
- `MEMORY_LLM_BASE_URL / MEMORY_LLM_API_KEY / MEMORY_LLM_MODEL`（`:36-39`）——供 memory + memory-hub 内部使用。
- `PROXY_UPSTREAM_URL / PROXY_UPSTREAM_API_KEY / PROXY_UPSTREAM_MODEL`（`:43-45`）——供 proxy 转发。
- 默认值均为 `REPLACE_ME`。

### 5.2 require_vars 硬校验 —— "无 LLM 运行"的最大阻断点

- `deploy/global-images/_lib.sh:34-49`（`require_vars`）：任一变量为空或仍为 `REPLACE_ME` → 打印缺失项并 **`exit 1`**（`_lib.sh:47`）。`load_env` 见 `_lib.sh:23-31`。
- `deploy/global-images/start-all.sh:21-27`：对**两套** LLM 变量都调用 `require_vars`，随后才启动 memory → memory-hub → proxy。
- 各子脚本同样强制：
  - `start-memory-hub.sh:20-23`：`require_vars MEMORY_LLM_*`；`:104-108`：向容器注入 `-e LLM_MODE=custom -e LLM_API_KEY/BASE_URL/MODEL`。
  - `start-memory-core.sh:63-67`：由 `MEMORY_LLM_*` 生成 gateway 的 `llm:` 段。
  - `start-proxy.sh:20-22`：`require_vars PROXY_UPSTREAM_*`；`:84-86`：由 `PROXY_UPSTREAM_*` 生成 config.yaml 的 upstream url/apiKey。

### 5.3 验证脚本留了逃生门

- `deploy/global-images/verify.sh`：支持 `--skip-llm` 标志，可跳过对 LLM 的实活探测（dry-run 检查仍在）。**这是部署层唯一已存在的"无 LLM"开关**。

### 5.4 文档要求

- `INSTALL.md` / `INSTALL_CN.md`：明确要求在 `.env` 中填写两套 LLM 参数后方可启动。

### 5.5 deploy 小结

- **现状**：三件套 Docker 启动脚本**强制要求两套 LLM 环境变量**，缺一即 `exit 1` 拒绝启动。代码层大多"无 LLM 也能跑"，但部署脚本在入口处把它拦死了。
- **改造点（按代价从低到高）**：
  1. 直接改 `start-all.sh` / 各 `start-*.sh` 的 `require_vars` 调用，去掉 LLM 变量（或新增 `--no-llm` 开关跳过校验）。
  2. 仿照 `verify.sh --skip-llm` 的思路，给启动脚本也加 `--no-llm`。
  3. 让 `start-memory-hub.sh` 在 `--no-llm` 时不注入 `-e LLM_MODE=custom`，改为 `LLM_MODE=proxy` 且不推绑定——此时 KS Wiki 摄入会 fail loudly，但 CodeGraph/检索不受影响。

---

## 6. 汇总：无 LLM 运行判定表

### 6.1 失效的功能（必须 LLM）

| 功能 | 位置 | 失效方式 |
|---|---|---|
| Wiki 摄入（分析阶段） | `MemoryKnowledge/src/engines/wiki/ingest-v2/index.ts:118-122` | `createLlmClient` 抛错（`llm.ts:90-101`），构建 status=failed（`wiki-service.ts:1059`） |
| Wiki 摄入（生成阶段） | `index.ts:132` / `index.ts:136` | 同上 |
| Wiki 页面合并 | `merge.ts:147` / `merge.ts:178` | 依赖摄入，随之失效（但 `merge.ts:91` 判重命中可绕过） |
| Wiki 概览生成 | `overview.ts:99`、`manager.ts:582-584` | 同上 |
| Wiki 摘要 | `callback.ts:106-113` | **软失效**：失败返回 `""`，不阻断 |
| 经 Proxy 的推理转发 | `handler.ts:912/293/347`、`anthropicHandler.ts:1039` | 服务可启动，请求时失败 |
| memory-hub 服务端抽取 | `MemoryCore/src/adapters/standalone/llm-runner.ts:286/321` | 无 key 时该路径不可用 |

### 6.2 仍可工作的功能（无需 LLM）

| 功能 | 位置 |
|---|---|
| CodeGraph 构建（静态分析） | `MemoryKnowledge/src/engines/code/bridge.ts:106-134` |
| CodeGraph 摘要（模板） | `callback.ts:127-136`、`code-graph-service.ts:370` |
| BM25 / FTS5 检索 | `manager.ts:332-342`（`bm25()` `:338`）、`index-db.ts:76` |
| 图多跳 BFS 检索 | `graph-search.ts:40-91` |
| 本地分词 / 路径规范化 / FILE 块解析 | `manager.ts:291-325`、`index.ts:285-310`、`index.ts:139` |
| Proxy 启动 / sessionInit 假表单 / 上下文注入 / tdai 记录 / skill 抽取转发 | `session/form.ts`、`context-injector.ts:106-122`、`pipeline.ts:80-147`、`recorder.ts:32`、`handler-glue.ts:70` |
| Cost Guard 直通降级（子模块空） | `guard-adapter.ts:106-115/259-268` |
| Panel 全部 CRUD / 反代 / 启动 | `MemoryPanel/README.md`、`wiki-routes.ts`、`ensure-knowledge-llm-binding.ts:87-164` |
| SDK 全部 v3 API / BM25 检索 | `client.ts:8-26`、`v3/http.ts:8`、`skill-types.ts:144/421` |

### 6.3 改造点清单（让系统"零 LLM 可运行"）

1. **部署层（必须，否则起不来）**：改 `deploy/global-images/_lib.sh:34-49` 的 `require_vars` 或在 `start-all.sh:21-27` / 各 `start-*.sh` 增加 `--no-llm` 开关跳过两套 LLM 变量校验。参照 `verify.sh --skip-llm`。
2. **KS 摄入降级（可选，避免 Wiki 构建硬失败）**：在 `ingest-v2/llm.ts:80-83` 的 `LlmClient` 接口上注入 no-op 实现，经 `index.ts:86` 的 `options.llm ??` 注入口传入；或把 `llm.ts:90-101` 的 throw 改为返回空实现，使摄入退化为"仅解析入库"。参照 `callback.ts` 摘要"失败返回空串"的既有容错。
3. **memory-hub 注入方式**：`start-memory-hub.sh:104-108` 在 `--no-llm` 时不注入 `LLM_MODE=custom`，改 `proxy` 且不推绑定（此时 Wiki 摄入 fail loudly，但 CodeGraph/检索照常）。
4. **SDK / Proxy / Panel**：无需改造——本就零推理依赖；SDK 可用 `client.ts:24-26` 的 `Transport` 注入口做离线打桩。

### 6.4 最终回答

> **无 LLM 时**：三件套**默认无法启动**——不是代码不能跑，而是 `deploy/global-images/_lib.sh:34-49` 的 `require_vars` 在入口强制两套 LLM 环境变量、缺即 `exit 1`。一旦绕过该校验，系统大部分能力仍然可用：CodeGraph 构建、BM25/FTS/图多跳检索、Proxy 的会话注入/写侧/转发骨架、Panel 全部 CRUD、SDK 全部 API 均不依赖 LLM。**真正失效的只有 MemoryKnowledge 的 Wiki 摄入/合并/概览/摘要链路**（`createLlmClient` fail loudly）以及一切需要上游 LLM 出 token 的推理转发。改造成本最低的路径是给部署脚本加 `--no-llm` 开关；若还想让 Wiki 构建"降级而非失败"，则在 `llm.ts` 的 `LlmClient` 注入口挂一个空实现即可。

---

*附：本报告基于 v2.0.0 静态分析；`MemoryProxy/packages/cost-guard` 为空子模块、`MemoryKnowledge` 检索侧无 embedding 实现等均为当前代码库的观察事实。*
