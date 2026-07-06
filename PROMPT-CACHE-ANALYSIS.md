# Prompt 前缀缓存回归分析 / Prompt Prefix-Cache Regression Analysis

> Issue [#120](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/120) — prependContext + showInjected 导致 OpenAI-compatible provider 前缀缓存命中率退化

---

## 中文

### 1. 现象

启用 memory-tencentdb 插件（叠加 OpenClaw 5.19 → 5.28 升级）后，依赖**前缀匹配缓存**（prefix-matching cache）的 OpenAI-compatible 提供商命中率显著退化：

| 日期 | OpenClaw | TencentDB | MiMo 命中率 | DeepSeek 命中率 |
|------|----------|-----------|------------|----------------|
| 5/29 | 5.19 | ❌ 未上线 | 91.1% | 95.7% |
| 5/31 | 5.28 | ✅ 全量 | 63.5% | 83.3% |

### 2. 机制

**前缀缓存入门**：DeepSeek / MiMo（`openai-completions` API）的缓存以「本次请求序列化字节流与历史请求的最长公共前缀」计费——**第一个分歧字节之后的所有内容全部 miss**。系统提示是请求的最前部字节，其后依次是对话历史、当前用户消息。因此：越靠前的字节发生抖动，损失越是灾难性的。

本插件（修复前）+ 宿主行为共同构成三条失效链：

**链 A（主因）：prependContext → showInjected 冻结 → 历史膨胀 → 截断抖动**

1. 插件每轮把召回记忆（`<relevant-memories>…</relevant-memories>`，约 500–1700 tokens）注入当前用户消息前缀（`prependContext`）。
2. 宿主 `showInjected=true` 时，这些一次性内容被**永久冻结**进对话历史——此后每轮请求都要重发全部历史注入块。
3. 上下文以远超正常速度膨胀，更早、更频繁地触发宿主的 tool-result truncation；截断量按**当轮剩余 token 预算动态计算**，每轮不同。
4. 截断改写的是**历史前部**的字节 → 前缀在极靠前的位置分歧 → 整个请求 miss。命中率跌至 63.5%。

**链 B（次因）：appendSystemContext 位于 CACHE_BOUNDARY 之后的动态尾部**

宿主 `composeSystemPromptWithHookContext` 把 hook 返回的系统上下文（本插件的 persona + 场景导航 + 工具指南，约 4000 字符）**直接拼接到系统提示动态尾部**（CACHE_BOUNDARY 之后、每轮动态内容之后），从未调用已有的 `prependSystemPromptAdditionAfterCacheBoundary`。即使内容字节级稳定，也因位于每轮变化的动态区**下游**而永远无法命中缓存，每轮按全新 token 计费。

**链 C（去重缺失）：稳定块每轮重组 → 漂移与闪断**

修复前稳定块每轮从磁盘重组：L2/L3 管线**会话中途改写** `persona.md` / 场景索引 → 系统提示（请求最前部）字节变化 → 全请求 miss；召回超时那一轮返回空 → persona **消失一轮再出现** → 连续两次前缀失效。不存在任何会话级去重/冻结概念。

### 3. 修复

全部修复位于插件侧，默认开启、均有旧行为逃生门（`openclaw.plugin.json` 中的 4 个新 `recall.*` 配置项）：

| 配置项 | 默认 | 切断的失效链 | 旧行为逃生门 |
|---|---|---|---|
| `recall.stripInjectedFromHistory` | `true` | 链 A：`before_message_write` 钩子在历史持久化前剥离 `<relevant-memories>`，注入内容仅当轮生效（ephemeral），历史零膨胀 | `false` 恢复冻结注入 |
| `recall.stableContextPolicy` | `"session-frozen"` | 链 C：`StableRecallContextCache` 按 sessionKey 冻结首次组装的稳定块字节；中途 persona 改写被吸收、召回超时不再闪断（60 分钟空闲 TTL + LRU 上限） | `"latest"` 恢复每轮重组 |
| `recall.systemInjection` | `"auto"` | 链 B：运行时探测宿主 `prependSystemPromptAdditionAfterCacheBoundary`（依次探测 event / ctx / api / api.runtime），命中则每轮以**字节相同**的冻结块调用之（宿主为逐轮重组的 replace 模型），并从 hook 返回值中省略 `appendSystemContext` 防止双重注入；宿主缺失该 API 或调用抛错时自动回退旧路径 | `"hook-context"` 强制旧路径 |
| `recall.injectionMode` | `"ephemeral"` | 链 A 强化：`"session-stable"` 模式首轮召回后把记忆折叠进冻结稳定块，此后各轮 `prependContext` 为空且跳过 L1 搜索——每轮请求成为上一轮的**纯字节扩展** | 默认值即旧行为 |

**完成度说明**：冻结/去重（链 C）、历史剥离（链 A）、session-stable 模式为**纯插件侧完整修复**；稳定位置放置（链 B）为**宿主协作型**——插件已就绪，宿主暴露 API 即自动生效，否则行为与修复前完全一致。

**会话级去重语义**：稳定块在一个会话内解析为**唯一规范字节序列**（sha256 指纹漂移检测 + 计数），无论上游重组多少次、注入 API 每轮调用多少次，到达 provider 的字节永不改变——这正是 issue 建议 3 要求的去重。

**与 offload 上下文引擎的关系**：`src/offload` 的 Context Engine 是独立且互斥的注入路径——其 `assemble()` 返回的 `systemPromptAddition` 是 L4 结果的**一次性**注入（在 L4 完成的那一轮消费一次，并非每轮重组），设计上即意味着该轮一次前缀失效，属预期成本；本修复的 4 个 `recall.*` 配置项不作用于该路径。TdaiCore 的冻结/去重作用于 `before_prompt_build` 召回路径与 Gateway `/recall`（按 `session_key` 生效）。

### 4. 上游（OpenClaw）建议

以下问题只能在宿主侧根治（符号名以 5.28 为准，可能随版本漂移）：

1. **`composeSystemPromptWithHookContext`**（系统提示组装器）：将 hook 系统上下文改经 `prependSystemPromptAdditionAfterCacheBoundary` 放置（而非动态尾部直拼）；更理想的是提供 `beforeCacheBoundary` 变体，把会话级稳定内容放到 **CACHE_BOUNDARY 之前**，使 Anthropic 风格断点缓存也能覆盖（issue 建议 1）。
2. **`showInjected`**：向会话历史持久化**干净的**用户原文，注入内容每轮临时渲染；或对 `openai-completions` 提供商默认 `showInjected=false`；并让 `before_message_write` 的返回值同时作用于**内存态历史**而不仅是落盘 transcript。
3. **Tool-result truncation**：把截断量量化为稳定台阶（例如按消息序号固定 4k-token 桶，而非按当轮剩余预算连续取值），使相同历史前缀在相邻轮次序列化结果字节一致。
4. **为插件提供文档化的「缓存稳定系统追加」hook 返回字段**（例如 `stableSystemContext`），插件无需运行时能力探测。

### 5. 验证

- **离线**：`__tests__/prompt-cache-stability.test.ts` 用 FakeOpenClawHost 驱动真实 `register()` 跑 6 轮对话，逐轮断言序列化请求的最长公共前缀（LCP）：ephemeral 模式分歧不早于上一轮当前用户消息；session-stable 模式为纯字节扩展（LCP ≥ 上一轮全长 − 2）；并覆盖历史清洁、注入器字节一致、persona 改写免疫、双注入防护与回退路径。运行：`npx vitest run`。
- **线上 A/B**：对比开启修复前后 DeepSeek usage 中的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（MiMo 对应字段同理）。预期：命中率回升至 ~90%+（链 A/C 消除后剩余 miss 主要来自宿主截断与链 B 未升级宿主的部分）。

---

## English

### 1. Symptoms

After enabling the memory-tencentdb plugin (compounded by the OpenClaw 5.19 → 5.28 upgrade), cache hit rates on prefix-matching OpenAI-compatible providers degraded sharply:

| Date | OpenClaw | TencentDB | MiMo Hit Rate | DeepSeek Hit Rate |
|------|----------|-----------|---------------|-------------------|
| May 29 | 5.19 | ❌ Off | 91.1% | 95.7% |
| May 31 | 5.28 | ✅ On | 63.5% | 83.3% |

### 2. Mechanism

**Prefix-cache primer**: DeepSeek / MiMo (`openai-completions` API) charge cache hits by the longest byte-identical prefix between the serialized request and previous requests — **everything after the first divergent byte is a miss**. The system prompt is the very first bytes of the request, followed by conversation history, then the current user message. The earlier a byte flutters, the more catastrophic the loss.

The pre-fix plugin + host behavior formed three failure chains:

**Chain A (primary): prependContext → showInjected freeze → history bloat → truncation jitter**

1. The plugin prepends recalled memories (`<relevant-memories>…</relevant-memories>`, ~500–1700 tokens) to each turn's user message (`prependContext`).
2. With host `showInjected=true`, this one-shot content is **permanently frozen** into conversation history — every later request re-sends every historical injected block.
3. Context inflates far faster than normal, triggering the host's tool-result truncation earlier and more often; the truncation amount is computed from the **per-turn remaining token budget** and differs every turn.
4. Truncation rewrites **early** history bytes → the prefix diverges near the top of the request → whole-request miss. Hit rate collapses to 63.5%.

**Chain B (secondary): appendSystemContext placed after CACHE_BOUNDARY, at the dynamic tail**

The host's `composeSystemPromptWithHookContext` tail-appends hook system context (our persona + scene navigation + tools guide, ~4000 chars) after the CACHE_BOUNDARY **and after the per-turn dynamic region**, never calling the existing `prependSystemPromptAdditionAfterCacheBoundary`. Even byte-stable content downstream of per-turn dynamic tokens can never cache-extend — it is re-billed as fresh input every turn.

**Chain C (missing dedup): per-turn recompose → drift and flicker**

The stable block was recomposed from disk every turn: the L2/L3 pipelines **rewrite `persona.md` / the scene index mid-session** → system-prompt bytes (the first bytes of the request) change → full-request miss; a recall timeout returned nothing for one turn → the persona **disappeared and reappeared** → two consecutive prefix busts. No session-level dedup/freeze concept existed.

### 3. Fixes

All fixes are plugin-side, on by default, each with a legacy escape hatch (4 new `recall.*` keys in `openclaw.plugin.json`):

| Config key | Default | Chain it cuts | Legacy escape hatch |
|---|---|---|---|
| `recall.stripInjectedFromHistory` | `true` | Chain A: the `before_message_write` hook strips `<relevant-memories>` before history persist — injection is ephemeral (current turn only), history stays lean | `false` restores frozen injection |
| `recall.stableContextPolicy` | `"session-frozen"` | Chain C: `StableRecallContextCache` byte-freezes the first composed stable block per sessionKey; mid-session persona rewrites are absorbed and recall timeouts no longer flicker the block out (60-min idle TTL + LRU cap) | `"latest"` restores per-turn recompose |
| `recall.systemInjection` | `"auto"` | Chain B: runtime-probe the host for `prependSystemPromptAdditionAfterCacheBoundary` (event / ctx / api / api.runtime, in order); when found, call it every turn with the **byte-identical** frozen block (the host recomposes per build — replace model) and omit `appendSystemContext` from the hook result to prevent double injection; missing API or a throwing call falls back to the legacy path | `"hook-context"` forces the legacy path |
| `recall.injectionMode` | `"ephemeral"` | Chain A, reinforced: `"session-stable"` folds turn-1 memories into the frozen stable block; later turns have no `prependContext` and skip the L1 search — each request becomes a **pure byte-extension** of the previous one | the default IS the legacy behavior |

**Completeness**: freeze/dedup (Chain C), history strip (Chain A), and session-stable mode are **complete plugin-side fixes**; stable placement (Chain B) is **host-cooperative** — the plugin is ready and activates automatically once the host exposes the API; otherwise behavior is bit-for-bit identical to before the fix.

**Session-level dedup semantics**: within a session the stable block resolves to **one canonical byte sequence** (sha256 fingerprint drift detection + counter). No matter how often it is recomposed upstream or how many times the injection API is invoked, the provider-visible bytes never change — exactly the dedup requested by issue suggestion 3.

**Interplay with the offload context engine**: the Context Engine in `src/offload` is a separate, mutually exclusive injection path — its `assemble()` returns a **one-shot** L4 `systemPromptAddition` (consumed once on the turn L4 completes, not recomposed per turn), which by design costs a single prefix miss on that turn and is an accepted cost; the four `recall.*` knobs do not govern that path. The TdaiCore freeze/dedup applies to the `before_prompt_build` recall path and to Gateway `/recall` (keyed by `session_key`).

### 4. Upstream (OpenClaw) recommendations

These can only be fixed in the host (symbol names as of 5.28; may drift):

1. **`composeSystemPromptWithHookContext`** (prompt composer): route hook system additions through `prependSystemPromptAdditionAfterCacheBoundary` instead of tail-appending; better yet, add a `beforeCacheBoundary` variant so session-stable additions land **before** CACHE_BOUNDARY and Anthropic-style breakpoint caching covers them too (issue suggestion 1).
2. **`showInjected`**: persist the CLEAN user prompt to session history and render injected context ephemerally per turn (or default `showInjected=false` for `openai-completions` providers); honor `before_message_write` results for the in-memory history, not just the on-disk transcript.
3. **Tool-result truncation**: quantize truncation to stable steps (e.g. fixed 4k-token buckets keyed to message index, not the continuous remaining budget) so identical history prefixes serialize byte-identically turn-over-turn.
4. **Expose a documented hook-result field for "cache-stable system addition"** (e.g. `stableSystemContext`) so plugins do not need runtime capability probes.

### 5. Verification

- **Offline**: `__tests__/prompt-cache-stability.test.ts` drives the real `register()` through a FakeOpenClawHost over 6 conversation turns and asserts the longest common prefix (LCP) of the serialized requests turn-over-turn: in ephemeral mode divergence occurs no earlier than the previous turn's current user message; in session-stable mode every request is a pure byte extension (LCP ≥ previous full length − 2). It also covers history cleanliness, byte-identical injector arguments, persona-rewrite immunity, double-injection protection, and every fallback path. Run: `npx vitest run`.
- **Production A/B**: compare `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` in DeepSeek usage (MiMo equivalents) with the fixes on vs. off. Expected: hit rate recovers to ~90%+ (with Chains A/C eliminated, residual misses come mainly from host truncation and, on hosts without the placement API, Chain B).
