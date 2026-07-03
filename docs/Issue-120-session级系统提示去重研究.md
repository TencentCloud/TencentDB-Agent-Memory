# Issue 120：session 级系统提示去重研究

## 范围

Issue #120 的拓展级验收可以从两条线里选一条做：对比不同 provider 的缓存策略差异，或者研究 session 级系统提示去重。本页记录第二条。

当前插件在每次 `before_prompt_build` 里通过 `appendSystemContext` 返回稳定记忆上下文：

- L3 persona
- L2 scene navigation
- memory tools guide

这些内容在同一个 session 内通常低频变化，但仍会每轮返回给 OpenClaw。原因是当前可见的 hook 契约没有提供可移植的返回语义，用来表示“把这段系统提示追加内容安装到 session，并由 host 后续复用”。插件也不能简单地在第二轮以后停止返回 `appendSystemContext`，否则当前/旧版 host 上模型可能看不到 persona 和场景导航。

## 已实现边界

本仓库新增了 host 无关的工具：`src/utils/system-prompt-dedupe.ts`。

它提供三类能力：

- `digestStableSystemPrompt(text)`：对归一化后的稳定系统提示块计算 digest。
- `dedupeStableSystemPromptAdditions(additions)`：去掉同一次系统提示组装里的重复稳定追加块。
- `observeSessionSystemPromptShape(sessionKey, text)`：记录同一 session 内稳定系统上下文是首次出现、保持一致，还是发生变化。

运行时策略保持保守：

- 插件仍然每轮返回完整 `appendSystemContext`。
- 同一次 `appendSystemContext` 内，如果出现完全重复的稳定块，会在返回 hook result 前按 digest 去重。
- `index.ts` 以 debug 日志记录 stable system context 的 shape 和 digest。
- 除非未来 host 明确支持 session 持久系统提示追加，否则插件不会跨轮省略 persona 或 scene context。

这样处理可以避免当前行为丢上下文，同时给后续 host 侧去重留下可复用的 digest/shape 基础。

## Host 侧去重模型

如果 host 支持把稳定 hook addition 按 session 持久保存，可以按下面的规则处理：

1. 把稳定追加内容拆成带来源名的独立块。
2. 对每个块做 normalize 和 digest。
3. 同一 session 内 digest 已安装过时，不再把该块重复追加到系统提示。
4. digest 变化时，安装新块，并刷新该 session 的稳定系统提示 shape。
5. 动态 L1 recall 继续放在 `prependContext`，不要提升到稳定系统前缀。

关键安全条件是：模型仍然必须能通过 host session state 看到稳定追加内容。只有“插件不再返回文本”，但 host 没有持久保存语义时，这种去重是不安全的。

## 验证方式

本地测试：

```text
npx.cmd vitest run src/utils/system-prompt-dedupe.test.ts
```

Provider 探针：

```text
node tmp/session-system-prompt-cache-probe.mjs
```

脚本只读取环境变量：

- DeepSeek：`DEEPSEEK_API_KEY`，可选 `DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`
- Mimo：`MIMO_API_KEY`，可选 `MIMO_BASE_URL`、`MIMO_MODEL`

探针对比两个场景：

- `重复追加`：每轮都多重复一份相同的稳定 memory system addition，用来模拟 session 级稳定系统提示误累积。
- `去重追加`：每轮只保留一份稳定 memory system addition，用来模拟 session digest 去重，同时保证模型仍然看得到稳定上下文。

主要指标：

- 总 `prompt_tokens`
- `cache_hit_tokens`
- `cache_miss_tokens`
- cache hit ratio
- 每轮 stable system prompt digest

预期观察是：`去重追加` 的总 prompt tokens 和 cache miss tokens 低于 `重复追加`。cache hit ratio 不能单独作为判断依据，因为旧文本重复进入前缀后可能抬高 hit ratio，但同时也会增加总上下文规模。

## 真实 API 验证结果

测试时间：2026-07-03。

报告文件：

```text
tmp/issue120-e2e-results/session-system-prompt-cache-probe-1783042675700.json
```

公共设置：

- 轮数：5。
- 场景一 `重复追加`：第 N 轮系统提示中重复 N 份相同 stable memory addition。
- 场景二 `去重追加`：每轮系统提示只保留 1 份 stable memory addition。
- 两个场景都保留模型可见的稳定上下文，区别只在是否重复追加同一稳定块。

### DeepSeek

- API：OpenAI-compatible Chat Completions。
- 模型：`deepseek-v4-pro`。

| 场景 | 总 prompt tokens | cache hit tokens | cache miss tokens | cache hit ratio |
| --- | ---: | ---: | ---: | ---: |
| 重复追加 | 57,370 | 39,040 | 18,330 | 68.05% |
| 去重追加 | 24,460 | 24,320 | 140 | 99.43% |

相对变化：

| 指标 | 变化 |
| --- | ---: |
| prompt tokens | -32,910（-57.36%） |
| cache miss tokens | -18,190（-99.24%） |
| cache hit ratio | +31.38 pp |

逐轮观察：

- `重复追加` 的 system chars 从 26,586 增长到 97,318，每轮 digest 都变化，说明稳定系统提示前缀持续被改写。
- `去重追加` 的 system chars 固定为 26,586，digest 固定为 `3154005592f6`，DeepSeek 每轮 miss tokens 稳定为 28。

### Mimo

- API：OpenAI-compatible Chat Completions。
- 模型：`mimo-v2.5-pro`。

| 场景 | 总 prompt tokens | cache hit tokens | cache miss tokens | cache hit ratio |
| --- | ---: | ---: | ---: | ---: |
| 重复追加 | 63,275 | 41,920 | 21,355 | 66.25% |
| 去重追加 | 27,255 | 25,856 | 1,399 | 94.87% |

相对变化：

| 指标 | 变化 |
| --- | ---: |
| prompt tokens | -36,020（-56.93%） |
| cache miss tokens | -19,956（-93.45%） |
| cache hit ratio | +28.62 pp |

逐轮观察：

- `重复追加` 的 system chars 同样从 26,586 增长到 97,318，每轮 digest 都变化。
- `去重追加` 的 system chars 固定为 26,586，digest 固定为 `3154005592f6`。
- Mimo 的 `去重追加` 前 4 轮 miss tokens 都是 11，第 5 轮 miss tokens 为 1,355；即便有单轮波动，总 miss tokens 仍比 `重复追加` 低 93.45%。

## 结论

这组 DeepSeek 和 Mimo 数据说明 session 级稳定系统提示去重有实际收益：

- 去重后系统提示 shape 稳定，digest 不再逐轮变化。
- 两家 provider 的总 prompt tokens 都下降约 57%。
- DeepSeek 的 cache miss tokens 下降 99.24%，Mimo 下降 93.45%。
- 该优化针对的是稳定系统提示重复累积；动态 L1 recall 仍应保留在 `prependContext`，并继续使用 `showInjected=false`、session recall 去重和 recall 预算来控制上下文膨胀。

基于这个边界，插件侧目前只落地“同轮稳定块 digest 去重 + 跨轮 shape 观测”。如果 OpenClaw host 后续提供 session 持久系统提示追加能力，可以沿用这套 digest 机制做真正的跨轮系统提示去重。
