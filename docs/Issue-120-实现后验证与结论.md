# Issue 120：A/B/C 实现后验证

## 说明

本页记录实现后的验证数据和结论。方案设计见：

- [Issue-120-showInjected对话膨胀趋势与优化方案.md](./Issue-120-showInjected对话膨胀趋势与优化方案.md)

本次验证覆盖下面三个方向：

- A：默认不持久化 raw `<relevant-memories>`，当前轮可见，历史保存干净用户消息。
- B：session 级 recall digest 去重；`skip` 直接跳过重复 L1 memory，`reminder` 将重复项压缩为短提醒。
- C：动态 recall 硬预算，限制单条和总 recall 字符数。

## 本地验证

实现后补了下面几类测试：

- `src/config.test.ts`：覆盖 `showInjected`、`dedupeInjected`、`dedupeMode`、`dedupeInjectedTtlTurns`、`maxReminderChars`、recall budget 配置解析。
- `src/utils/recall-injection.test.ts`：覆盖 `<relevant-memories>` 在字符串和 message parts 中的清理。
- `src/utils/recall-context.test.ts`：覆盖 recall budget、session digest 去重、reminder、TTL 和 digest normalize。

本地命令：

```text
npx.cmd vitest run
npm.cmd run build:plugin
```

结果：

- `npx.cmd vitest run`：7 个 test files / 82 个 tests 通过。
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
- 输出上限：DeepSeek 10 轮 usage benchmark 使用 16 output tokens；Mimo 10 轮 usage benchmark 使用 64 max tokens。Mimo E2E 为避免 reasoning tokens 消耗过小输出预算，使用 2400 max tokens。
- 测试脚本只从环境变量读取 API key，未写入仓库。
- 验证时不只看 input/prompt tokens，也看 cache hit ratio、cached/hit tokens 和 miss tokens。`showInjected` 风险基线可能因为旧 recall 进入历史而得到较高命中率，所以同时比较命中率和 miss tokens。

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

注意：`A+B+C 合并` 是 10 轮 usage benchmark 的聚合指标，主要用于观察输入规模、miss tokens 和历史膨胀趋势；它不是下面 E2E 表里的 `ABC_reminder`。两者的轮数、任务提示、输出预算和重复 recall 处理方式不同，cache hit ratio 不能直接互相替代。

## Mimo

配置：

- API：Mimo OpenAI-compatible Chat Completions
- base URL：`https://api.xiaomimimo.com/v1`
- endpoint：`/chat/completions`
- 模型：`mimo-v2.5-pro`
- `enable_thinking`：`false`
- 指标：`prompt_tokens`、`prompt_tokens_details.cached_tokens`、`prompt_cache_miss_tokens`
- 10 轮报告：`tmp/issue120-e2e-results/issue120-showinjected-growth-mimo-1783001359804.json`

汇总：

| 场景 | 第 1 轮 prompt tokens | 第 10 轮 prompt tokens | 10 轮增长 | 首轮后平均增长 | 总 prompt tokens | cache hit tokens | cache miss tokens | cache hit ratio | 总 recall chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| showInjected 风险基线 | 3,790 | 19,431 | 15,641 | 1,737.89 | 115,784 | 112,064 | 3,720 | 96.79% | 82,670 |
| A：历史干净 | 3,790 | 4,042 | 252 | 28.00 | 38,836 | 38,528 | 308 | 99.21% | 82,670 |
| B：A + session 去重 | 3,790 | 2,251 | -1,539 | -171.00 | 23,364 | 22,976 | 388 | 98.34% | 8,259 |
| C：A + recall 预算 | 2,494 | 2,685 | 191 | 21.22 | 25,807 | 20,480 | 5,327 | 79.36% | 17,210 |
| A+B+C 合并 | 2,494 | 2,252 | -242 | -26.89 | 22,070 | 21,568 | 502 | 97.73% | 1,719 |

逐轮 prompt tokens：

| 轮次 | showInjected 风险基线 | A：历史干净 | B：A + 去重 | C：A + 预算 | A+B+C |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 3,790 | 3,790 | 3,790 | 2,494 | 2,494 |
| 2 | 5,519 | 3,809 | 2,099 | 2,512 | 2,099 |
| 3 | 7,248 | 3,828 | 2,118 | 2,531 | 2,118 |
| 4 | 8,977 | 3,847 | 2,137 | 2,550 | 2,137 |
| 5 | 10,706 | 3,866 | 2,156 | 2,569 | 2,156 |
| 6 | 12,435 | 3,885 | 2,175 | 2,588 | 2,175 |
| 7 | 14,164 | 3,904 | 2,194 | 2,607 | 2,194 |
| 8 | 15,893 | 3,923 | 2,213 | 2,626 | 2,213 |
| 9 | 17,621 | 3,942 | 2,231 | 2,645 | 2,232 |
| 10 | 19,431 | 4,042 | 2,251 | 2,685 | 2,252 |

观察：

- A 把第 10 轮 prompt tokens 从 19,431 降到 4,042，历史增长从每轮约 1,738 tokens 降到 28 tokens。
- B 把总 prompt tokens 从 A 的 38,836 降到 23,364，但 miss tokens 比 A 略高，说明去重并不等于每个缓存指标都改善。
- C 把首轮 prompt tokens 从 A 的 3,790 降到 2,494，但这组 Mimo 实测里 cache hit ratio 下降、miss tokens 上升，不能单独作为缓存优化结论。
- A+B+C 合并后总 prompt tokens 最低，比风险基线下降 80.94%；miss tokens 比风险基线下降 86.51%；cache hit ratio 比风险基线高 0.94 pp。

## E2E 对照：skip vs reminder

10 轮 usage benchmark 只能证明 token 和 cache 变化，不能证明同一任务结果是否一致。补充了一组 2 轮 E2E 任务：

- 任务：根据同一批召回事实输出 release brief JSON。
- 评分：最终 JSON 必须覆盖 product、release_target、owner、database、feature_flag_storage、compliance、primary_risk、mitigation、smoke_test、ready。
- 场景：`showInjected_risk`、`ABC_skip`、`ABC_reminder`。
- 脚本：`tmp/issue120-e2e-cache-compare.mjs`。
- Mimo 输出预算：2400 max tokens；低预算下该模型可能把输出额度消耗在 reasoning tokens 上，导致 content 为空。

所以，下面 E2E 表里的 cache hit ratio 只和同一张 E2E 表内的风险基线、`ABC_skip`、`ABC_reminder` 比较；不要和上面的 10 轮 usage benchmark 逐项对齐。

### DeepSeek v4-flash

报告：`tmp/issue120-e2e-results/issue120-e2e-1782990384303.json`

| 场景 | 同一任务通过 | prompt tokens | cache hit tokens | cache miss tokens | cache hit ratio | 相对风险基线 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| showInjected 风险基线 | 是 | 6,812 | 5,888 | 924 | 86.44% | - |
| ABC_skip | 否 | 4,756 | 4,608 | 148 | 96.89% | token -30.18%，miss -83.98%，但最终输出为空 |
| ABC_reminder | 是 | 4,962 | 4,608 | 354 | 92.87% | token -27.16%，miss -61.69%，hit ratio +6.43 pp |

结论：`skip` 的缓存指标更好，但任务失败，不能直接作为默认方案。`reminder` 保留了关键事实，结果通过，同时仍明显降低总 prompt tokens 和 miss tokens。

### Mimo

报告：`tmp/issue120-e2e-results/issue120-e2e-1783000020966.json`

| 场景 | 同一任务通过 | prompt tokens | cache hit tokens | cache miss tokens | cache hit ratio | 相对风险基线 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| showInjected 风险基线 | 是 | 7,382 | 6,400 | 982 | 86.70% | - |
| ABC_skip | 否 | 5,421 | 4,736 | 685 | 87.36% | token -26.56%，miss -30.24%，但 `ready` 类型不符合评分要求 |
| ABC_reminder | 是 | 5,651 | 4,736 | 915 | 83.81% | token -23.45%，miss -6.82%，hit ratio -2.89 pp |

结论：Mimo 上 `reminder` 比 `skip` 更稳，因为 `skip` 的最终 JSON 将 `ready` 输出成说明文本而不是布尔值，未通过同一任务评分。`ABC_reminder` 通过同一任务，并降低总 prompt tokens 和 miss tokens；但 cache hit ratio 比风险基线低 2.89 个百分点，不能把这项结果表述为命中率完全修复。

E2E 结论：

- 只做 `skip` 会把缓存指标和质量拉向不同方向，尤其会放大“看起来省 token，但事实缺失或空输出”的风险。
- 当前按 `ABC_reminder` 落地更稳：不持久化 raw recall，重复项压缩为短提醒，在 DeepSeek 和 Mimo 上都保持任务通过，并降低总输入和 miss tokens。
- Mimo 这组 E2E 显示：任务通过和 miss tokens 下降可以同时成立，但 cache hit ratio 仍可能下降。所以当前实现是缓解上下文膨胀和 miss 成本，不是对所有 provider 的“命中率完全修复”。
- 后续评估应把“同一任务通过”作为硬门槛，再比较 total tokens、miss tokens 和 cache hit ratio。

## 缓存指标口径

判断口径以 E2E 通过为硬门槛，再比较总 tokens、miss tokens 和 cache hit ratio。`showInjected` 风险基线的命中率不能直接当成好结果：旧 `<relevant-memories>` 被写入历史后，后续轮次会反复携带同一批大块文本，provider 更容易把这些旧文本算成 cache hit；但总输入和上下文窗口占用同时变大。

当前采用的候选是 `ABC_reminder`，不是旧的 `ABC_skip`。

| 场景 | DeepSeek v4-flash E2E cache hit ratio | Mimo E2E cache hit ratio |
| --- | ---: | ---: |
| showInjected 风险基线 | 86.44% | 86.70% |
| ABC_skip | 96.89%（任务失败） | 87.36%（任务失败） |
| ABC_reminder | 92.87% | 83.81% |

E2E 对照：

| Provider | 采用方案 | 同一任务通过 | token 变化 | miss tokens 变化 | cache hit ratio 变化 |
| --- | --- | --- | ---: | ---: | ---: |
| DeepSeek v4-flash | ABC_reminder | 是 | -27.16% | -61.69% | +6.43 pp |
| Mimo v2.5 pro | ABC_reminder | 是 | -23.45% | -6.82% | -2.89 pp |

旧的 10 轮 A/B/C benchmark 仍有参考价值，但它没有验证同一任务输出质量；下面只作为阶段性缓存/输入规模对照，不再作为方案选择的主要依据。

## 阶段性 10 轮 benchmark 缓存指标

各方案实现后的阶段性缓存命中率：

| 场景 | DeepSeek cache hit ratio | Mimo cache hit ratio |
| --- | ---: | ---: |
| showInjected 风险基线 | 83.54% | 96.79% |
| A：历史干净 | 51.93% | 99.21% |
| B：A + session 去重 | 75.43% | 98.34% |
| C：A + recall 预算 | 79.85% | 79.36% |
| A+B+C 合并 | 81.33% | 97.73% |

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

DeepSeek 的 A 单独看会降低 cache hit ratio，并且 miss tokens 比风险基线多 6,237。这个结果符合预期：A 去掉的是“旧 recall 被写入历史后形成的虚高命中”。A 的主要收益是把第 10 轮 prompt 从 70,851 降到 16,318，把总 prompt tokens 从 434,370 降到 161,695。B/C 继续减少动态 miss 部分，A+B+C 把 miss tokens 压到 19,281。

Mimo 相对风险基线：

| 场景 | cache hit ratio | 相对风险基线 | cache miss tokens | 相对风险基线 |
| --- | ---: | ---: | ---: | ---: |
| showInjected 风险基线 | 96.79% | - | 3,720 | - |
| A：历史干净 | 99.21% | +2.42 pp | 308 | -3,412 |
| B：A + session 去重 | 98.34% | +1.55 pp | 388 | -3,332 |
| C：A + recall 预算 | 79.36% | -17.43 pp | 5,327 | +1,607 |
| A+B+C 合并 | 97.73% | +0.94 pp | 502 | -3,218 |

Mimo 相对 A：

| 场景 | cache hit ratio 变化 | cache miss tokens 变化 |
| --- | ---: | ---: |
| B：A + session 去重 | -0.87 pp | +80 |
| C：A + recall 预算 | -19.85 pp | +5,019 |
| A+B+C 合并 | -1.48 pp | +194 |

Mimo 这组里，`showInjected` 风险基线本身已经有很高 cache hit ratio，但总 prompt tokens 膨胀到 115,784。A 把总 prompt tokens 降到 38,836，并把 miss tokens 从 3,720 降到 308。A+B+C 的总 prompt tokens 最低，为 22,070；相对风险基线 miss tokens 下降 3,218，但相对 A 的 miss tokens 多 194，说明 Mimo 上 B/C 更主要的收益是减少总输入规模，而不是在每一项缓存指标上都优于 A。

阶段性 benchmark 结论：

- A 解决历史膨胀，不保证单独提升 cache hit ratio；如果旧 recall 进入历史，命中率可能虚高。
- B/C 直接减少动态 recall 和重复 recall，能明显降低 miss tokens。
- 旧 A+B+C/ABC_skip 在 10 轮 usage benchmark 中缓存指标较好，但没有证明同一任务输出质量。
- E2E 复测后，当前选择 `ABC_reminder`：相比 `skip` 多保留少量 token，换来 DeepSeek 和 Mimo 都通过同一任务，同时相对风险基线降低 miss tokens。
- Mimo E2E 的 cache hit ratio 下降，说明当前实现不能表述为“完全解决缓存命中率问题”；更准确的结论是减少上下文膨胀、降低总输入和 miss tokens，并通过同一任务质量门槛。
- 评估效果时不能只看 cache hit ratio，还要同时看总 input/prompt tokens 和 miss tokens。

## 结论

| 方向 | 结果 | 说明 |
| --- | --- | --- |
| A：默认不持久化 raw recall | 有效 | 两家 provider 的第 10 轮输入规模都降了不少。A 解决的是历史线性膨胀。 |
| B：session 级注入去重 | 需要 reminder 模式 | `skip` 虽能降低输入，但 E2E 中可能丢事实或空输出；`reminder` 在保留关键事实的同时降低 miss tokens。 |
| C：动态 recall 硬预算 | 有效 | 首轮和每轮动态 recall 的输入规模下降。C 解决的是单轮 recall 块过大的问题。 |
| A+B+C 合并 | `ABC_reminder` 可作为当前候选 | DeepSeek 和 Mimo 的 E2E 都通过，并相对风险基线降低总输入和 miss tokens；但 Mimo E2E 的 cache hit ratio 下降，不能写成已经完全修复缓存命中率。`ABC_skip` 只作为对照，不建议作为默认。 |

当前取舍：

- A 应作为默认行为。
- `showInjected=true` 只保留为调试开关，并明确提示上下文膨胀风险。
- B/C 保持可配置；`dedupeMode=reminder` 是当前更稳的默认候选，`skip` 只适合极端 token 压缩或低风险事实。
- 指标上继续记录 injected count、recall chars/tokens、dedupe hit、budget cut、cache hit/miss，后续用真实会话数据调默认值。
