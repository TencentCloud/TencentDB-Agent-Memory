# Provider 缓存策略对比：DeepSeek vs MiMo

本文对比 DeepSeek 和 MiMo 在 prompt caching 上的公开信息与工程影响。结论用于解释为什么本 PR 选择“缓存分区 + `showInjected` 策略调优”作为低风险主实现。

## 资料来源

- DeepSeek Context Caching: https://api-docs.deepseek.com/guides/kv_cache/
- DeepSeek Pricing: https://api-docs.deepseek.com/quick_start/pricing/
- MiMo OpenAI-compatible Chat API: https://mimo.mi.com/docs/en-US/api/chat/openai-api
- MiMo Pay-as-you-go Pricing: https://mimo.mi.com/docs/price/pay-as-you-go

说明：DeepSeek 官方文档对 context caching 的前缀匹配机制描述更直接；MiMo 官方文档重点暴露 OpenAI-compatible API 和 cache-hit / cache-miss 价格差异，但未像 DeepSeek 一样展开完整 prefix unit 规则。因此本文对 MiMo 的缓存行为只做工程侧推断，不把未公开细节写成确定事实。

## DeepSeek

DeepSeek 官方文档说明 context caching 默认启用，并且缓存命中依赖请求前缀复用。其文档提到 cache prefix unit 的概念，后续请求只有完整复用对应前缀单元时才更容易命中。

工程影响：

- prompt 前缀越稳定，越有利于命中缓存。
- 动态内容越早出现在 prompt 中，越容易破坏后续 prefix matching。
- 将 L3 persona、L2 scene navigation、tools guide 这类稳定内容与 L1 recalled memories 分区，是符合 DeepSeek 缓存模型的。
- `showInjected=true` 导致动态 L1 记忆进入历史后，会使后续 prompt prefix 更容易漂移。

## MiMo

MiMo 官方文档提供 OpenAI-compatible Chat API；价格页列出了 cache-hit input 和 cache-miss input 的不同价格，说明 MiMo 也存在缓存命中带来的成本差异。

工程影响：

- MiMo 与 OpenAI-compatible message array 对齐，因此消息顺序和前缀稳定性仍然重要。
- 价格页显示 cache-hit 与 cache-miss 成本不同，因此优化缓存命中率有直接成本意义。
- 公开文档未详细说明 prefix unit / cache boundary 规则，所以实现上应采用 provider 无关的稳妥策略：稳定内容尽量靠前、动态内容尽量靠后、避免动态注入进入 durable history。

## 对比表

| 维度 | DeepSeek | MiMo |
| --- | --- | --- |
| API 形态 | OpenAI-compatible | OpenAI-compatible |
| 缓存公开信息 | 官方文档明确讲 context caching 和 cache prefix unit | 官方价格页体现 cache-hit / cache-miss 成本差异 |
| 工程重点 | 保持可复用前缀稳定 | 保持 message array 前缀稳定，降低 cache-miss 成本 |
| `showInjected` 风险 | 动态记忆进入历史会造成 prefix drift | 同样会造成历史膨胀和动态前缀漂移 |
| 本 PR 策略适配性 | 高 | 高 |

## 为什么不能只针对单一 provider 优化

本仓库面向 OpenAI-compatible provider，不应把某个 provider 的私有细节写死到 memory 注入逻辑里。更稳妥的策略是优化 prompt shape：

1. 稳定系统侧内容保持稳定。
2. 动态 L1 recall 保持在当前轮动态区。
3. `showInjected=false` 阻止动态记忆进入后续历史。
4. 用 `promptCacheImpact` 指标观察稳定 token、动态 token 和估算命中率变化。

## 结论

DeepSeek 和 MiMo 的公开文档细节不同，但工程结论一致：缓存命中依赖稳定前缀，动态记忆不应污染后续历史。

因此本 PR 的 provider-agnostic 方案是合理的：不绑定 DeepSeek 或 MiMo 的内部实现，只保证 prompt 结构更缓存友好，并通过指标体现优化效果。
