# Issue 120：A/B/C 实现后验证

## 说明

这份文档只记录实现后的验证数据和结论。方案设计见：

- [Issue-120-showInjected对话膨胀趋势与优化方案.md](./Issue-120-showInjected对话膨胀趋势与优化方案.md)

本次验证覆盖三个方向：

- A：默认不持久化 raw `<relevant-memories>`，当前轮可见，历史保存干净用户消息。
- B：session 级 recall digest 去重，跳过同一 session 内已经注入过的重复 L1 memory。
- C：动态 recall 硬预算，限制单条和总 recall 字符数。

## 本地验证

实现后补了下面几类测试：

- `src/config.test.ts`：覆盖 `showInjected`、`dedupeInjected`、`dedupeInjectedTtlTurns`、recall budget 配置解析。
- `src/utils/recall-injection.test.ts`：覆盖 `<relevant-memories>` 在字符串和 message parts 中的清理。
- `src/utils/recall-context.test.ts`：覆盖 recall budget、session digest 去重、TTL 和 digest normalize。

本地命令：

```text
npx.cmd vitest run
npm.cmd run build:plugin
```

结果：

- `npx.cmd vitest run`：7 个 test files / 79 个 tests 通过。
- `npm.cmd run build:plugin`：通过。

## 真实 API 验证方法

每个 provider 各跑 5 组场景，每组 10 轮：

| 场景 | 含义 |
| --- | --- |
| `show_injected_risk` | 风险基线：当前轮注入 recall，并把 raw recall 写入历史。 |
| `A_ephemeral` | 只启用 A：当前轮注入完整 recall，历史只保存干净 prompt。 |
| `B_dedupe` | 启用 A + B：首轮注入完整 recall，后续跳过重复稳定 memory。 |
| `C_budget` | 启用 A + C：每轮 recall 按预算裁剪。 |
| `ABC_combined` | 同时启用 A + B + C。 |

公共参数：

- 测试时间：2026-07-02。
- 每组轮数：10。
- 输出上限：16 output tokens。
- 测试脚本只从环境变量读取 API key，未写入仓库。
- 验证重点：不只看 input/prompt tokens，也看 cache hit ratio、cached/hit tokens 和 miss tokens。`showInjected` 风险基线可能因为旧 recall 进入历史而得到较高命中率，所以这里同时比较命中率和 miss tokens。

## DeepSeek

配置：

- API：DeepSeek OpenAI-compatible Chat Completions
- 模型：`deepseek-v4-flash`
- 指标：`prompt_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`

汇总：

| 场景 | 第 1 轮 prompt tokens | 第 10 轮 prompt tokens | 10 轮增长 | 首轮后平均增长 | 总 prompt tokens | cache hit tokens | cache miss tokens | cache hit ratio | 总 recall chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| showInjected 风险基线 | 16,023 | 70,851 | 54,828 | 6,092.00 | 434,370 | 362,880 | 71,490 | 83.54% | 326,630 |
| A：历史干净 | 16,021 | 16,318 | 297 | 33.00 | 161,695 | 83,968 | 77,727 | 51.93% | 326,630 |
| B：A + session 去重 | 16,019 | 10,717 | -5,302 | -589.11 | 111,320 | 83,968 | 27,352 | 75.43% | 55,100 |
| C：A + recall 预算 | 10,376 | 10,655 | 279 | 31.00 | 105,155 | 83,968 | 21,187 | 79.85% | 19,170 |
| A+B+C 合并 | 10,378 | 10,447 | 69 | 7.67 | 103,249 | 83,968 | 19,281 | 81.33% | 10,523 |

逐轮 prompt tokens：

| 轮次 | showInjected 风险基线 | A：历史干净 | B：A + 去重 | C：A + 预算 | A+B+C |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 16,023 | 16,021 | 16,019 | 10,376 | 10,378 |
| 2 | 22,115 | 16,054 | 10,461 | 10,407 | 10,191 |
| 3 | 28,207 | 16,087 | 10,493 | 10,438 | 10,223 |
| 4 | 34,299 | 16,120 | 10,525 | 10,469 | 10,255 |
| 5 | 40,391 | 16,153 | 10,557 | 10,500 | 10,287 |
| 6 | 46,483 | 16,186 | 10,589 | 10,531 | 10,319 |
| 7 | 52,575 | 16,219 | 10,621 | 10,562 | 10,351 |
| 8 | 58,667 | 16,252 | 10,653 | 10,593 | 10,383 |
| 9 | 64,759 | 16,285 | 10,685 | 10,624 | 10,415 |
| 10 | 70,851 | 16,318 | 10,717 | 10,655 | 10,447 |

观察：

- A 把第 10 轮 prompt tokens 从 70,851 降到 16,318，历史增长从每轮约 6,092 tokens 降到 33 tokens。
- B 把总 prompt tokens 从 A 的 161,695 降到 111,320，cache miss tokens 从 77,727 降到 27,352。
- C 把首轮 prompt tokens 从 A 的 16,021 降到 10,376，总 prompt tokens 降到 105,155。
- A+B+C 合并后总 prompt tokens 和 cache miss tokens 最低，第 10 轮为 10,447。
- showInjected 风险基线的 cache hit ratio 更高，但它用了 434,370 总 prompt tokens 换缓存命中，不能只看 ratio。

## GPT-5.5 Responses API

配置：

- API：OpenAI-compatible Responses API
- base URL：`https://api.ai-pixel.online`
- endpoint：`/v1/responses`
- 模型：`gpt-5.5`
- reasoning effort：`xhigh`
- `store`：`false`
- 指标：`input_tokens`、`input_tokens_details.cached_tokens`

汇总：

| 场景 | 第 1 轮 input tokens | 第 10 轮 input tokens | 10 轮增长 | 首轮后平均增长 | 总 input tokens | cached tokens | miss tokens | cache hit ratio | 总 recall chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| showInjected 风险基线 | 15,438 | 69,816 | 54,378 | 6,042.00 | 426,270 | 93,952 | 332,318 | 22.04% | 326,630 |
| A：历史干净 | 15,432 | 15,765 | 333 | 37.00 | 155,985 | 17,920 | 138,065 | 11.49% | 326,630 |
| B：A + session 去重 | 15,434 | 10,236 | -5,198 | -577.56 | 106,190 | 35,840 | 70,350 | 33.75% | 55,100 |
| C：A + recall 预算 | 9,836 | 10,160 | 324 | 36.00 | 99,980 | 26,880 | 73,100 | 26.89% | 19,170 |
| A+B+C 合并 | 9,840 | 9,970 | 130 | 14.44 | 98,202 | 36,352 | 61,850 | 37.02% | 10,523 |

逐轮 input tokens：

| 轮次 | showInjected 风险基线 | A：历史干净 | B：A + 去重 | C：A + 预算 | A+B+C |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 15,438 | 15,432 | 15,434 | 9,836 | 9,840 |
| 2 | 21,480 | 15,469 | 9,932 | 9,872 | 9,666 |
| 3 | 27,522 | 15,506 | 9,970 | 9,908 | 9,704 |
| 4 | 33,564 | 15,543 | 10,008 | 9,944 | 9,742 |
| 5 | 39,606 | 15,580 | 10,046 | 9,980 | 9,780 |
| 6 | 45,648 | 15,617 | 10,084 | 10,016 | 9,818 |
| 7 | 51,690 | 15,654 | 10,122 | 10,052 | 9,856 |
| 8 | 57,732 | 15,691 | 10,160 | 10,088 | 9,894 |
| 9 | 63,774 | 15,728 | 10,198 | 10,124 | 9,932 |
| 10 | 69,816 | 15,765 | 10,236 | 10,160 | 9,970 |

观察：

- A 把第 10 轮 input tokens 从 69,816 降到 15,765，历史增长从每轮约 6,042 tokens 降到 37 tokens。
- B 把总 input tokens 从 A 的 155,985 降到 106,190，cache hit ratio 从 11.49% 到 33.75%。
- C 把总 input tokens 降到 99,980，首轮输入从 A 的 15,432 降到 9,836。
- A+B+C 合并后总 input tokens 最低，miss tokens 最低，cache hit ratio 最高。第 10 轮 input tokens 是风险基线的 14.28%。

## 缓存命中率变化

这里单独把缓存指标拉出来看。`showInjected` 风险基线的命中率不能直接当成好结果：旧 `<relevant-memories>` 被写入历史后，后续轮次会反复携带同一批大块文本，provider 更容易把这些旧文本算成 cache hit；但总输入和上下文窗口占用同时变大。

各方案实现后的缓存命中率：

| 场景 | DeepSeek cache hit ratio | GPT-5.5 cache hit ratio |
| --- | ---: | ---: |
| showInjected 风险基线 | 83.54% | 22.04% |
| A：历史干净 | 51.93% | 11.49% |
| B：A + session 去重 | 75.43% | 33.75% |
| C：A + recall 预算 | 79.85% | 26.89% |
| A+B+C 合并 | 81.33% | 37.02% |

DeepSeek 相对风险基线：

| 场景 | cache hit ratio | 相对风险基线 | cache miss tokens | 相对风险基线 |
| --- | ---: | ---: | ---: | ---: |
| showInjected 风险基线 | 83.54% | - | 71,490 | - |
| A：历史干净 | 51.93% | -31.61 pp | 77,727 | +6,237 |
| B：A + session 去重 | 75.43% | -8.11 pp | 27,352 | -44,138 |
| C：A + recall 预算 | 79.85% | -3.69 pp | 21,187 | -50,303 |
| A+B+C 合并 | 81.33% | -2.21 pp | 19,281 | -52,209 |

DeepSeek 相对 A：

| 场景 | cache hit ratio 变化 | cache miss tokens 变化 |
| --- | ---: | ---: |
| B：A + session 去重 | +23.50 pp | -50,375 |
| C：A + recall 预算 | +27.92 pp | -56,540 |
| A+B+C 合并 | +29.40 pp | -58,446 |

DeepSeek 的 A 单独看会降低 cache hit ratio，并且 miss tokens 比风险基线多 6,237。这个结果符合预期：A 去掉的是“旧 recall 被写入历史后形成的虚高命中”。A 的主要收益是把第 10 轮 prompt 从 70,851 降到 16,318，把总 prompt tokens 从 434,370 降到 161,695。B/C 继续减少动态 miss 部分，A+B+C 最终把 miss tokens 压到 19,281。

GPT-5.5 Responses API 相对风险基线：

| 场景 | cache hit ratio | 相对风险基线 | miss tokens | 相对风险基线 |
| --- | ---: | ---: | ---: | ---: |
| showInjected 风险基线 | 22.04% | - | 332,318 | - |
| A：历史干净 | 11.49% | -10.55 pp | 138,065 | -194,253 |
| B：A + session 去重 | 33.75% | +11.71 pp | 70,350 | -261,968 |
| C：A + recall 预算 | 26.89% | +4.85 pp | 73,100 | -259,218 |
| A+B+C 合并 | 37.02% | +14.98 pp | 61,850 | -270,468 |

GPT-5.5 Responses API 相对 A：

| 场景 | cache hit ratio 变化 | miss tokens 变化 |
| --- | ---: | ---: |
| B：A + session 去重 | +22.26 pp | -67,715 |
| C：A + recall 预算 | +15.40 pp | -64,965 |
| A+B+C 合并 | +25.53 pp | -76,215 |

GPT-5.5 这组里，A 已经把 miss tokens 从 332,318 降到 138,065；B/C 继续提升命中率并减少 miss。A+B+C 的 cache hit ratio 达到 37.02%，比风险基线高 14.98 个百分点，比 A 高 25.53 个百分点，同时 miss tokens 最低。

缓存指标结论：

- A 解决历史膨胀，不保证单独提升 cache hit ratio；如果旧 recall 进入历史，命中率可能虚高。
- B/C 直接减少动态 recall 和重复 recall，能明显降低 miss tokens。
- A+B+C 是缓存指标最稳的组合：DeepSeek miss tokens 降到 19,281，GPT-5.5 miss tokens 降到 61,850；GPT-5.5 的 cache hit ratio 也提升到最高。
- 评估效果时不能只看 cache hit ratio，还要同时看总 input/prompt tokens 和 miss tokens。

## 结论

| 方向 | 结果 | 说明 |
| --- | --- | --- |
| A：默认不持久化 raw recall | 有效 | 两家 provider 第 10 轮输入都从约 7 万 tokens 降到约 1.6 万 tokens。A 解决的是历史线性膨胀。 |
| B：session 级注入去重 | 有效 | 重复稳定 memory 被跳过后，总输入和 miss tokens 明显下降。B 适合长 session 里反复召回同一批事实的场景。 |
| C：动态 recall 硬预算 | 有效 | 首轮和每轮动态 recall 的输入规模下降。C 解决的是单轮 recall 块过大的问题。 |
| A+B+C 合并 | 有效 | 两家 provider 都得到最低或接近最低的总输入、最低 miss tokens 和最小历史增长。 |

落地判断：

- A 应作为默认行为。
- `showInjected=true` 只保留为调试开关，并明确提示上下文膨胀风险。
- B/C 保持可配置；默认值可以保守，但文档需要给出长 session 下的建议配置。
- 指标上应继续记录 injected count、recall chars/tokens、dedupe hit、budget cut、cache hit/miss，后续用真实会话数据调默认值。
