# Issue 120：showInjected 膨胀分析与优化方案

## 说明

这份文档只记录 `showInjected` 风险形态、膨胀趋势和方案设计。实现后的 A/B/C 验证数据单独放在：

- [Issue-120-实现后验证与结论.md](./Issue-120-实现后验证与结论.md)

Issue 初始分析时，仓库还没有解析 `recall.showInjected`。当时把 `showInjected=true` 按等价运行时形态处理：`<relevant-memories>...</relevant-memories>` 不在持久化前清理，而是跟用户消息一起进入历史。后续实现已经补上 `recall.showInjected`，默认值为 `false`。

## 资料依据

定方案前，我补了一轮相关资料，主要核对两件事：provider prompt cache 的匹配条件，以及主流框架和 memory 项目怎么区分检索上下文、短期历史和长期记忆。

- DeepSeek Context Caching：<https://api-docs.deepseek.com/guides/kv_cache>
  - 上下文缓存默认开启。
  - usage 中提供 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。
- DeepSeek Pricing：<https://api-docs.deepseek.com/quick_start/pricing>
  - cache hit input token 成本低于 cache miss input token。
- OpenAI Prompt Caching：<https://platform.openai.com/docs/guides/prompt-caching>
  - 缓存命中依赖一致的 prompt prefix。
  - 静态内容靠前，变量内容靠后。
- Anthropic Prompt Caching：<https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>
  - cache breakpoint 前的 block 需要保持稳定。
- LangGraph memory：<https://docs.langchain.com/oss/python/concepts/memory>
  - short-term memory 和 long-term memory 分开；长 history 会增加成本、延迟和注意力干扰。
- CrewAI memory：<https://docs.crewai.com/en/concepts/memory>
  - task 前召回 context，task 后从 output 抽取离散事实入库。
- Semantic Kernel chat history reducer：<https://learn.microsoft.com/en-us/semantic-kernel/concepts/ai-services/chat-completion/chat-history>
  - 用 truncation / summarization / token-based reducer 控制 chat history。
- Letta context hierarchy / compaction：<https://docs.letta.com/guides/core-concepts/memory/context-hierarchy>、<https://docs.letta.com/guides/core-concepts/messages/compaction>
  - 区分常驻 memory、archival memory、conversation search 和 compaction。

基于这些资料，这里采用的边界是：检索内容只作为读路径上的 prompt-time context 使用；长期 memory 应该来自抽取和整理后的稳定状态，不直接把原始检索片段回灌进去。

## 初始复现实测

为了确认问题规模，先用合成会话做了三组对比：

1. `baseline_no_injection`：不注入 L1 recall。
2. `clean_history_current_injection_only`：当前轮注入 L1 recall，但历史只保存干净用户 prompt。
3. `show_injected_preserved_history`：当前轮注入 L1 recall，并把注入块一起写入历史，模拟 `showInjected=true` 风险形态。

每组 10 轮，使用同一类稳定 system prefix 和每轮变化的 `<relevant-memories>` 块。

### DeepSeek

- API：DeepSeek OpenAI-compatible Chat Completions
- 模型：`deepseek-v4-flash`
- 测试时间：2026-07-02
- 每轮输出上限：40 tokens

| 场景 | 第 1 轮 prompt tokens | 第 10 轮 prompt tokens | 10 轮增长 | 首轮后平均增长 | 总 prompt tokens | cache hit ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline，无注入 | 4,035 | 4,377 | 342 | 38 | 42,060 | 88.25% |
| 当前轮注入，历史干净 | 10,060 | 10,402 | 342 | 38 | 102,310 | 31.90% |
| showInjected-style，历史保留注入 | 10,061 | 64,610 | 54,549 | 6,061 | 373,355 | 82.56% |

### GPT-5.5 Responses API

- API：OpenAI-compatible Responses API
- base URL：`https://api.ai-pixel.online`
- endpoint：`/v1/responses`
- 模型：`gpt-5.5`
- reasoning effort：`xhigh`
- `store`：`false`
- 测试时间：2026-07-02
- 每轮输出上限：40 tokens

| 场景 | 第 1 轮 input tokens | 第 10 轮 input tokens | 10 轮增长 | 首轮后平均增长 | 总 input tokens | cache hit ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline，无注入 | 3,684 | 4,269 | 585 | 65 | 39,765 | 9.66% |
| 当前轮注入，历史干净 | 9,351 | 9,945 | 594 | 66 | 96,480 | 3.45% |
| showInjected-style，历史保留注入 | 9,351 | 60,930 | 51,579 | 5,731 | 351,405 | 31.47% |

## 膨胀原因

`showInjected=true` 风险形态的问题不在当前轮注入本身，而在注入块进入历史后会被下轮继续带上。

```text
clean_history_prompt(turn n)
  ~= stable_prefix + current_recall + clean_history(n)

showInjected_prompt(turn n)
  ~= stable_prefix
   + current_recall
   + sum(previous_recall_blocks)
   + clean_history(n)
```

设单轮 recall 块为 `R`，正常对话历史增长为 `H`：

```text
历史干净：每轮增长约 H
showInjected：每轮增长约 H + R
```

实测里：

- DeepSeek：`H ~= 38 tokens / turn`，`R ~= 6,023 tokens / turn`。
- GPT-5.5：`H ~= 65-66 tokens / turn`，`R ~= 5,665 tokens / turn`。

所以第 10 轮时，showInjected-style 分别达到：

- DeepSeek：64,610 tokens，是历史干净注入的 6.21 倍。
- GPT-5.5：60,930 input tokens，是历史干净注入的 6.13 倍。

DeepSeek 在 showInjected-style 里有较高 cache hit ratio，但这不是健康状态。原因是旧注入块写入历史后变成了可复用前缀，cache hit tokens 上去了；同时总 prompt tokens 也膨胀到 373,355，是历史干净注入的 3.65 倍。上下文窗口、延迟和后续截断压力都会变差。

## 方案

这里采用三个方向，后续实现和验证也按这三个方向拆开看：

- A：默认不持久化 raw `<relevant-memories>`。
- B：session 级 recall digest 去重。
- C：动态 recall 硬预算。

### A. raw recall 默认 ephemeral

默认行为：

```text
当前请求：
  <relevant-memories>...</relevant-memories>
  用户 prompt

持久化历史：
  用户 prompt

trace / metrics：
  injected_memory_ids
  source_ids
  content_hashes
  scores
  token_counts
  injected_or_skipped_reasons
```

约束：

- `showInjected=false` 是默认运行模式。
- `before_message_write` 继续 strip `<relevant-memories>`。
- L0 recorder 使用注入前缓存的干净 prompt。
- `showInjected=true` 只作为调试开关，并在日志和配置说明里提示膨胀风险。
- 调试信息放日志、metrics、trace 或 artifact，不写回 chat transcript。

这条边界的含义是：recall 是本轮 evidence，不是新的 conversation history。

### B. session 级 recall digest 去重与 reminder

为每个 session 维护轻量 digest：

```text
sessionRecallDigest = {
  memory_id or sha256(normalized_memory_content): {
    firstInjectedAtTurn,
    lastInjectedAtTurn,
    sourceIds,
    lastScore,
    contentVersion,
    ttl
  }
}
```

规则：

1. 优先按稳定 `memory_id` 去重，没有 id 时使用 normalized content hash。
2. 同一 memory 在 TTL 内已经注入过，不再重复注入大块正文。
3. 重复项默认不应完全消失；更稳的做法是输出短 reminder，保留关键事实和实体名。
4. 当前问题明确要求证据、内容版本变化、分数变高、用户追问同一事实时，可以再次注入，但应压缩正文。
5. 多来源事实不能只保留一条来源；正文可以合并，trace 保留 `sourceIds`。
6. digest 只在 session 内生效，不替代长期 memory 层的 dedup/update，也不写入 prompt 前缀。

配置形态：

| 配置 | 含义 |
| --- | --- |
| `recall.dedupeMode=off` | 不做 session 级去重。 |
| `recall.dedupeMode=skip` | 重复项直接跳过，token 最省，但可能丢关键事实。 |
| `recall.dedupeMode=reminder` | 重复项转为短提醒，推荐作为缓存友好的默认候选继续验证。 |
| `recall.maxReminderChars` | 限制 reminder 总字符数，避免短提醒重新膨胀。 |

`reminder` 示例：

```xml
<memory-reminders>
以下记忆本 session 已注入过，保留为短提醒以避免重复大块上下文：

- [fact] Feature flags are stored in the config_flags table.
</memory-reminders>
```

B 的目标是减少重复上下文，不是隐藏证据。真实 E2E 里 `skip` 曾导致 DeepSeek 输出空 content 或丢失 `config_flags table` 细节，因此 `reminder` 比“直接跳过”更符合质量和缓存的折中目标。

### C. 动态 recall 硬预算

动态 recall 需要独立预算，不能只依赖模型总上下文窗口。

| 预算对象 | 处理方式 |
| --- | --- |
| stable system / tools / rules | 固定模板和版本，不放动态内容。 |
| session summary / digest | 设置最大 token/char，低频更新。 |
| recent turns | 保留最近 N 轮真实消息，并设置总 token 上限。 |
| retrieved memories | 设置 `top_k`、`min_score`、单条长度、总长度、source diversity。 |
| code / doc retrieval | 与 memory recall 分开设预算，避免挤占源码上下文。 |
| tool results | 大型结果使用摘要、分页、source pointer 或清理策略。 |

对 `retrieved memories` 的具体约束：

- `top_k`：默认 3-8 条，禁止无限追加。
- `min_score`：低相关 memory 不注入。
- `maxCharsPerMemory`：单条 memory 超长时截断或摘要。
- `maxTotalRecallChars`：动态 recall 建议不超过总上下文的 5%-15%，并设置硬上限。
- `source diversity`：避免 top-k 都来自同一场景或同一事实。
- 超预算时优先压缩相似事实，保留高置信来源和显式用户约束，不做静默尾部截断。

## 读写边界

后续实现按下面的边界走：

| 内容 | conversation history | long-term memory | trace / metrics |
| --- | --- | --- | --- |
| 用户原始消息 | 是 | 由抽取器决定 | 可记录 message id |
| assistant 回复 | 是 | 经抽取后才可写入 | 可记录 message id |
| 必要 tool result | 可选，受预算控制 | 经抽取后才可写入 | 可记录 tool call id |
| `<relevant-memories>` 原文 | 否 | 否 | 默认不保存原文 |
| recall 元数据 | 否 | 否 | 是 |
| session digest / compacted summary | 可作为 session state | 默认否 | 是 |
| 新事实 / 用户确认 / 显式纠错 / 稳定任务产物 | 否 | 是 | 是 |

长期 memory 写入不从 raw recall 直接来，而是走单独 pipeline：

```text
clean conversation / tool observation / final decision
  -> candidate extraction
  -> confidence / policy / user confirmation
  -> dedup / entity linking
  -> conflict handling
  -> provenance
  -> durable memory upsert
```

## 验收口径

验证时至少比较：

1. showInjected 风险基线：历史保留 raw recall。
2. A：默认不持久化 raw recall。
3. B：A + session digest dedupe。
4. C：A + recall 硬预算。
5. A+B+C：合并形态，其中应分别比较 `ABC_skip` 和 `ABC_reminder`。

主要看：

- 第 1 轮和第 10 轮 input/prompt tokens。
- 总 input/prompt tokens。
- cached tokens / cache hit tokens。
- cache miss tokens。
- 每轮增长速度。
- recall 实际注入规模。
- 同一任务最终输出是否语义一致，避免只优化 token 指标。

实现后的测量结果见 [Issue-120-实现后验证与结论.md](./Issue-120-实现后验证与结论.md)。
