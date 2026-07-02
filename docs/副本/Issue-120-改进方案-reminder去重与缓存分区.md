# Issue 120 改进方案：reminder 去重与缓存分区

## 背景

当前 A/B/C 实现已经把 raw `<relevant-memories>` 从持久化历史中剥离，并支持 session 级去重和 recall 预算。真实 E2E 暴露出两个问题：

- GPT-5.5 上优化有效：同一任务语义通过，input tokens 和 miss tokens 下降，cache hit ratio 提升。
- DeepSeek v4-flash 上 `ABC_skip` 总 prompt tokens 下降，但 cache miss tokens 反而上升，且最终输出把 `config_flags table` 简化成 `config_flags`。

这说明“重复 recall 直接跳过”对缓存和质量都不够稳。它减少了输入量，但会让模型在后续轮缺少关键事实，也可能让 DeepSeek 失去上一轮完整 prefix unit 的复用机会。

## 外部资料依据

- DeepSeek Context Caching 是自动 KV cache，命中依赖与已缓存 prefix 的完整匹配；usage 暴露 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。参考：<https://api-docs.deepseek.com/guides/kv_cache>
- OpenAI Prompt Caching 自动生效，稳定前缀越长越容易复用；Responses/Chat usage 暴露 `cached_tokens`。参考：<https://developers.openai.com/api/docs/guides/prompt-caching>
- Anthropic Prompt Caching 的最佳实践是把 cache breakpoint 放在稳定 block 末尾，而不是动态用户/召回内容上。参考：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>

插件层不能直接控制最终 provider 请求的 block/cache hint，因此插件侧应优先保证：

1. 稳定内容顺序固定，放在动态内容之前。
2. 当前轮动态 recall 不写入持久化历史。
3. 重复 recall 不再发送大块全文，但也不能完全消失。

## 方案

新增 `recall.dedupeMode`：

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| `off` | 不做 session 去重 | 默认兼容、安全基线 |
| `skip` | 重复 L1 记忆直接跳过 | token 最省，但可能丢关键事实 |
| `reminder` | 首次发送完整 bounded recall，重复项发送短提醒 | 推荐继续验证的折中方案 |

`reminder` 输出示例：

```xml
<memory-reminders>
以下记忆本 session 已注入过，保留为短提醒以避免重复大块上下文：

- [M3] Feature flags are stored in the config_flags table.
</memory-reminders>
```

同时新增 `recall.maxReminderChars` 控制 reminder 总字符预算，默认 `600`。

## 预期收益

- 相比 `showInjected=true`：不再让 raw recall 进入历史，避免上下文线性膨胀。
- 相比 `ABC_skip`：重复事实仍以短提醒存在，降低 DeepSeek v4-flash 中细节丢失风险。
- 相比每轮完整 recall：重复项成本小，动态区域更短，miss tokens 应低于风险基线。

## 风险

- reminder 仍是动态内容，不能保证 DeepSeek 一定命中 cache。
- 如果 reminder 太短，仍可能丢细节；太长则接近完整 recall。需要通过 `maxReminderChars` 和真实任务调默认值。
- provider 缓存收益仍取决于 host 最终拼接方式。OpenAI `prompt_cache_key`、Anthropic `cache_control` 需要在最终请求层实现，不适合插件用字符串假装控制。

## 测试矩阵

真实 E2E 应至少比较：

| 场景 | 说明 |
| --- | --- |
| `showInjected_risk` | 当前轮注入 recall，且 raw recall 写入历史 |
| `ABC_skip` | 不持久化 recall，重复 recall 直接跳过 |
| `ABC_reminder` | 不持久化 recall，重复 recall 转短提醒 |

评估指标：

- 同一任务最终输出是否语义通过。
- 总 input/prompt tokens。
- cache hit tokens / cached tokens。
- cache miss tokens。
- cache hit ratio。
- 每轮 recall chars 和最终输出中关键事实是否完整。

判断标准：

- 不能只看 cache hit ratio。
- 可行方案必须在同一任务通过的前提下，显著降低总 tokens 和/或 miss tokens。
- 如果某 provider cache ratio 不升，但总 tokens 和 miss tokens 下降、结果通过，可以判为缓解；若 miss tokens 变差或结果不通过，不能宣称完全修复。
