# Prompt Cache Context Design

## 问题重新定义

OpenAI-compatible provider 复用的是已经处理过的请求前缀。仅把本轮 L1 从
`prependContext` 移到 `appendContext`，或者在写历史前删除它，只能改变分叉位置：
当前轮模型看过的字节没有进入历史，下一轮仍会在上一条 user message 内发生分叉。

```text
旧方案，第 1 轮 provider 输入:  [system][recall A + user 1]
旧方案，第 2 轮 provider 输入:  [system][user 1][assistant 1][user 2 + recall B]
                                         ^ 上一轮 recall 被删除，前缀在这里断开
```

因此新方案的约束不是“把动态内容放到末尾”，而是：同一条 user message 在当前轮作为
模型输入时是什么字节，下一轮作为历史重放时仍必须是相同字节。

## Stable Cache Epoch + Memory Epoch Ledger

```text
system message（显式 Stable Cache Epoch 内冻结）
├─ Stable Snapshot: persona + scene navigation + epoch protocol + tools guide
├─ OpenClaw stable system prefix
├─ CACHE_BOUNDARY
└─ OpenClaw dynamic system suffix

messages（只追加）
├─ user 1: <!-- memory epoch 1: register A,B; focus A,B --> + 原始问题
├─ assistant 1
├─ user 2: 原始问题                         # A,B 未变化，无重复注入
├─ assistant 2
└─ user 3: <!-- memory epoch 2: register C; focus B,C --> + 原始问题
```

三项机制各自解决一个问题：

1. Stable Snapshot 在显式 Cache Epoch 内冻结。L2/L3 发布新 Persona/Scene 后推进
   Cache Epoch；活跃 session 下一轮切换到新 Snapshot，只发生一次有意的前缀失效。
2. 每轮仍执行 L1。首次遇到一个内容 ID 时 register 全文；后续主题切换只更新 focus IDs。
   召回集合相同则不注入，切回旧主题也不重复整块记忆。
3. `before_message_write` 把同一 Epoch Delta 写回当前 user message。Delta 使用 HTML
   comment，因此 Markdown UI 不渲染，但 provider 会收到原始文本。

Registry 与 Focus 必须分开：一次“本轮未召回”只代表 focus 变化，不代表记忆内容失效。
如果用 deactivate 表示缺席，主题 A→B→A 会重复注入 A 全文，既膨胀历史也破坏通用性。
Registry 因而只按内容 ID 注册一次，Focus 才随检索结果变化。

Recall 超时不代表 focus 变为空，因此不会生成新事件。Compaction 后历史 Epoch
可能被折叠，下一轮会写一个完整 checkpoint，随后继续增量记录。Gateway 重启后，
Ledger 从公开 hook 提供的历史 messages 重放已有 Registry 与 Focus，不依赖进程内 Map
猜测状态，也不会重复生成 `epoch:1`。

## 有界 Cache Epoch

严格前缀只维持在一个有 token 预算的 Epoch 内。有效预算为：

```text
min(recall.epochMaxTokens, floor(OpenClaw contextTokenBudget × 10%))
```

默认硬上限为 8192 tokens。事件计数使用项目已有的混合文本快速估算器，并额外保留 10%
安全余量，避免为预算判断在首轮加载完整 BPE tokenizer。每次持久化前还会预留一个 sealed
事件的空间，因此插件写入的 Epoch 事件不会先越界再封口。

```text
预算内: register / focus 作为可缓存事件写入历史
    ↓ 下一事件将超过预算
封口:   持久化 focus:none + sealed: token-budget
    ↓
等待期: 当前 L1 仍每轮执行，通过 ephemeral append 提供，但不写入历史
    ↓ OpenClaw after_compaction
新 Epoch: 只用当前召回工作集写 checkpoint，重新开放 Registry
```

OpenClaw 插件 API 没有公开的主动 compaction 方法，因此本插件不探测或调用内部 API。
即使宿主迟迟不 compaction，封口后新记忆也不会继续增加 transcript；代价是等待期的动态
召回不再享受完整的跨轮前缀连续性。compaction 旋转物理 session generation 时，Ledger
会保留当前 Cache Epoch 的 Stable Snapshot，并只把当前工作集带入新 generation。

## Prefix 连续性

```text
第 1 轮模型看到: <!-- epoch 1 -->\n\nuser 1
第 1 轮历史写入: <!-- epoch 1 -->\n\nuser 1
                     两者逐字一致

第 2 轮模型看到: [历史中的 epoch 1 + user 1][assistant 1][user 2]
```

这与 #375/#514 的 `appendContext + clean history` 不同：后者控制本轮动态区的位置，
本方案控制跨轮 transcript 的同一性。与 #533 的 `session-stable` 也不同：#533 冻结首轮
Top-K 并跳过后续 L1，本方案保留每轮检索，用追加 Epoch 表达变化。

## OpenClaw 宿主契约

- 稳定 Snapshot 通过 `prependSystemContext` 进入含 `CACHE_BOUNDARY` 的 base system
  之前；已核对官方发布包 `openclaw@2026.5.28` 的 hook 类型、
  `composeSystemPromptWithHookContext` 和 `SYSTEM_PROMPT_CACHE_BOUNDARY` 实现。插件最低
  OpenClaw 版本因此明确为 `2026.5.28`，不对更早且契约未知的版本静默降级。
- OpenClaw 2026.7.1 会临时把 hook context 写入当前模型 prompt，同时保存原始 transcript
  prompt。插件因此必须在 `before_message_write` 主动补入同一 Epoch，不能依赖宿主自动
  持久化 hook context。
- Epoch 不使用未公开的 message mutation 或 transcript API，只使用
  `before_prompt_build` 和 `before_message_write` 两个公开 hook。
- `before_prompt_build` 使用 `runId` 让同一轮 hook 重试保持幂等；
  `before_message_write` 不提供 `runId`，因此待写 Epoch 按 session 使用 FIFO 排队，
  与 OpenClaw 顺序写入 transcript 的契约对齐，避免并发轮次互相覆盖。
- `before_message_write` 的 session key 来自 hook context，而不是 event。真实 OpenClaw
  复测曾据此发现并修正“当前 prompt 有 Epoch、JSONL 没有 Epoch”的静默失配。

## 工程取舍

- 优点：provider 前缀可延续；L1 保持新鲜；重复召回不再线性膨胀；Epoch 使用 HTML
  comment，不占用 Markdown 的可见正文。
- 成本：预算内的新记忆会占用当前 Epoch 的历史 token；封口后的临时召回不再累积历史，
  但在宿主 compaction 前会牺牲一部分动态尾部缓存连续性。
- 语义：旧记忆不会从物理历史删除；Registry 保存已出现过的不可变内容，Focus 指定本轮
  应采用的 ID。主题 A→B→A 时，第二次 A 只写 ID。
- Persona/Scene 只在 L2/L3 明确发布后刷新；刷新会有意改写一次系统前缀，随后新
  Snapshot 在后续轮次继续稳定缓存，避免为了命中率长期向活跃 session 提供旧画像。
- 进程重启可以从 transcript 恢复 Registry 与 Focus；稳定 system snapshot 从当前显式
  Cache Epoch 重建。
- HTML comment 是否在每一种 OpenClaw 前端都完全隐藏仍需 UI smoke test；provider 与
  JSONL 的逐字一致性已经验证。

本地长会话验收使用 100 个高基数、内容各异的召回回合，而不是重复字符或按轮数触发。
在 512-token 测试预算下，第 5 轮封口，最终持久计数为 429 tokens；第 6–100 轮记忆正文
均未写入 transcript。快速估算器首次调用约 1.17 ms，热态相同召回约 0.002 ms/轮，
1000 个高基数回合约 0.0045 ms/轮。

真实 OpenClaw + `mimo-v2.5-pro` smoke 将预算临时设为 256 tokens，召回一条含 500 个不同
背景条目的多行记忆。两轮当前 prompt 分别注入 15,811 和 15,658 字符，MiMo 均正确回答；
JSONL 只出现一次 sealed 事件，500 行背景出现 0 次，两轮后 transcript 为 2,293 字节。
两轮 `cacheRead` 均为 0，验证了封口模式的明确取舍：限制历史增长优先于动态尾部缓存。
测试同时修正了多行 L1 在 Epoch 格式化时只保留首行的问题；多行正文现在以单行 JSON
字符串注册，结构化召回仍先应用原有单条和总字符预算。

## 真实 DeepSeek A/B（2026-07-31）

环境为 OpenClaw `2026.7.1-2`、DeepSeek `deepseek-v4-flash`。测试临时写入一条约
1 万字符的 L1 记忆，四轮问题在语义和长度上均有变化，但都明确指向同一记忆；测试后
按唯一 record ID 删除。首轮冷启动不纳入稳态统计。

| 模式 | 第 2–4 轮 prompt tokens | cacheRead | 未缓存 input | 加权命中率 | 平均总时长 | 回答正确 |
|---|---:|---:|---:|---:|---:|---:|
| epoch | 66,767 | 66,432 | 335 | 99.5% | 1,082 ms | 4/4 |
| append + clean history | 68,507 | 43,776 | 24,731 | 63.9% | 1,213 ms | 4/4 |

在这组样本中，Epoch 将未缓存输入减少 98.6%，稳态三轮平均总时长缩短约 10.8%。这
不是“速度固定提升 10.8%”的承诺：provider 排队和网络抖动会影响总时长，而且当前 CLI
没有返回独立 TTFT。短 recall 样本还会被约 3.5 万字符的 OpenClaw system prompt
掩盖，因此不能用短样本推断动态上下文优化无效。

Gateway 重启验证使用已存在的 session：重启后没有重复 Epoch，当前 prompt 保持原始
19 字符，DeepSeek 返回 `cacheRead=15,744 / promptTokens=15,877`，答案正确。

最终 Registry + Focus smoke test 采用 A→无关问题→A：第一轮 register 全文，第二轮
`focus` 切走，第三轮只用 170 字符的 Focus 事件切回；JSONL 中测试记忆全文只出现一次。
第二、三轮分别得到 `cacheRead=16,768 / promptTokens=16,880` 和
`16,768 / 16,965`，证明主题切回不再重发记忆正文。

Issue #120 使用的模型是 `mimo-v2.5-pro`，不是 `mimo-v2-flash`。最终测试使用四个独立
session，每种模式重复两组、每组六轮，共 24 次真实调用；执行顺序为 epoch、append、
append、epoch，以降低时间顺序偏差。每组使用不同的约 100 行自然变化背景和协议答案，
不是只改末尾字符的合成样本。首轮冷启动不纳入稳态统计。

| 模式 | 第 2–6 轮 prompt tokens | cacheRead | 加权命中率 | 本轮动态注入 | 时长中位数 | 严格按指令输出 |
|---|---:|---:|---:|---:|---:|---:|
| epoch | 220,581 | 186,240 | 84.43% | 23 字符/轮 | 1,622 ms | 12/12 |
| append + clean history | 243,897 | 157,376 | 64.53% | 3,449 字符/轮 | 1,920 ms | 7/12 |

Epoch 的加权缓存命中率提高 19.90 个百分点，平均 prompt tokens 减少 9.56%，重复动态
注入缩小约 150 倍。两种模式的答案都包含正确协议词，但 append 有一轮声称未检索到记忆，
且多轮没有遵守“只输出两个汉字”的指令。Epoch 的稳态时长中位数缩短 15.5%，但其中一轮
即使接近全量缓存命中仍耗时 23 秒，导致算术平均时长反而更高；这说明 provider 排队和网络
抖动足以盖过缓存收益，不能把本次命中率改善表述成固定的 TTFT 或总时长加速承诺。

## 与 Issue #120 的对应关系

- 稳定 persona/scene 位于缓存边界前：已实现，并在真实 OpenClaw prompt/provider 链路验证。
- `showInjected` 导致同一召回反复膨胀：Registry 只注册一次正文，Focus 仅追加内容 ID；
  legacy 模式仍清理 `<relevant-memories>`。
- Stable Cache Epoch：Snapshot 在 Epoch 内去重，L2/L3 更新显式推进 Epoch；Gateway
  重启从 transcript 恢复 Registry 与 Focus。
- 缓存命中改善：DeepSeek 大型 recall A/B 和 MiMo 2.5 Pro 的 24 回合重复 A/B 均已证明。
- 长会话 truncation：100 回合高基数测试证明插件持久增长受 token 预算约束；达到真实宿主
  截断阈值的端到端压力测试仍可作为后续补证。

因此当前实现满足 Issue 的根因修复与“深入”阶段，并完成双 provider 对比这一拓展项。
真实 truncation 阈值测试仍适合作为后续压力测试，但不影响本次缓存机制验收；PR 描述仍不应
把缓存命中改善写成固定的 TTFT 或总时长承诺。

## 禁止出现的实现

- 不为业务保证存在的字段增加重复判空。
- 不新增只有简单转发作用的 service/helper 层。
- 不为未声明的 OpenClaw 内部 API 增加多路探测和 fallback。
- 不按固定轮数猜测工作集是否变化；Epoch 由记忆集合的内容 ID 决定。
- 不冻结首轮 Top-K，也不关闭后续 L1。
- 不把“本地 Snapshot 构建加速”表述成 provider cache、TTFT 或成本加速。
- 不用末尾单字符变化的合成样本证明通用性；测试覆盖集合不变、增删、超时、compaction
  和新 session，最终结论使用真实 provider usage。

## 验收

- 当前轮模型使用的 Epoch 字节与写入历史的 Epoch 字节相同。
- 相同召回集合不生成新 Epoch；新内容写 register，主题变化只写 focus IDs。
- L2/L3 推进 Cache Epoch 后，当前 session 下一轮使用新 Snapshot；日志记录实际注入的
  Epoch/hash。
- Recall 超时保留当前 Focus；compaction 后只补一个 Registry checkpoint。
- Gateway 重启后从历史恢复 Epoch、Registry 和 Focus，不重复注入已有记忆。
- Epoch 达到 token 预算后只写一次 sealed 事件；后续召回不落历史，compaction 后只恢复
  当前工作集；物理 session generation 旋转保留当时的 Stable Cache Epoch。
- 全量测试、插件构建和 `git diff --check` 通过。
- DeepSeek/MiMo A/B 分别报告 cache-read tokens、prompt tokens、TTFT、总时长与回答质量；
  不把本地微基准外推成 provider 指标。
