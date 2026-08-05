# eval-memory — 可复现的记忆评测工具

一个自包含、按需运行的评测工具，端到端度量 **standalone Gateway** 的记忆质量，让社区可以在团队之外复现和对比 Benchmark 结果（见 issue [#106](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/106)、[#73](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/73)）。

[English](./README.md)

## 工作流程

对数据集中的每个对话：

1. **导入** — 逐轮通过 `POST /capture` 回放对话，每个 session 结束时调用 `POST /session/end` 强制刷新。
2. **等待管线** — 轮询 `POST /v2/pipeline/status` 等待 L1/L2/L3 队列排空（基于队列状态并带稳定窗口，避免把 L2/L3 级联定时器的间隙误判为完成）。
3. **回答** — 对每个评测问题调用 `POST /recall`，回答模型**只依据召回的上下文**作答；可选的 no-memory 基线直接用原始对话全文作答。
4. **评分** — 由 LLM 裁判对照标准答案打分（措辞宽松、事实严格）。裁判输出无法解析时按错误计，保证裁判不稳定只会低报、不会虚高。
5. **报告** — 输出 `report.json` + `report.md`：分类准确率、上下文 token 开销、管线统计，以及完整的运行元数据（commit、模型、数据集、生效的 Gateway 配置），使独立运行可逐项对比。

默认情况下，每个对话都会**独立拉起一个 Gateway 进程 + 全新数据目录**，不同对话的记忆绝不互相泄漏。每个对话生成的 Gateway 配置文件会保留在输出目录中，作为运行记录的一部分。

评测管线设计（ingest → search → judge）参考 [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)（Apache-2.0）。

## 前置条件

- Node.js ≥ 22.16.0，且已在 `MemoryCore/` 执行过 `npm install`
- 一个 OpenAI 兼容的 LLM 端点（Gateway 的 L1/L2/L3 提取和回答/裁判模型共用）

不引入任何新依赖：工具复用 MemoryCore 已声明的 `ai`、`@ai-sdk/openai`、`js-tiktoken`、`tsx`。不进入 npm 发布包，不参与 CI。

## 快速开始

```bash
cd MemoryCore

export TDAI_LLM_BASE_URL="https://api.openai.com/v1"
export TDAI_LLM_API_KEY="sk-..."
export TDAI_LLM_MODEL="gpt-4o-mini"

# 1. 内置小数据集连通性检查（约 1 分钟，少量 LLM 调用）
npm run eval:memory -- --dataset synthetic

# 2. 查看 LoCoMo 运行计划 — 不启动 Gateway、不调用 LLM
npm run eval:memory -- --dataset locomo --dry-run

# 3. LoCoMo 小切片（2 个对话 × 每对话 20 题）
npm run eval:memory -- --dataset locomo --max-conversations 2 --max-questions 20

# 4. 完整 LoCoMo + 全文基线对比
npm run eval:memory -- --dataset locomo --baseline full-context
```

结果输出到 `scripts/eval-memory/results/<时间戳>/`（已 git-ignore）。

## 数据集

| 适配器 | 内容 | 来源 |
| --- | --- | --- |
| `synthetic` | 1 个对话、2 个 session、4 个问题 — 确定性的连通性检查，**不是**质量基准 | 内置 |
| `locomo` | [LoCoMo](https://github.com/snap-research/locomo)（Maharana et al., ACL 2024）：10 个多 session 对话、约 1500 个评测问题（single-hop / multi-hop / temporal / open-domain） | 运行时从官方仓库下载 |

LoCoMo 数据集许可为 **CC BY-NC 4.0**，因此**不随仓库分发** — 工具在运行时从官方源下载（或用 `--locomo-path` 指定本地副本），请在其许可允许的非商业评测范围内使用。对抗性问题（category 5）默认排除，与 [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) 的常见做法一致；`--include-adversarial` 可包含。

LoCoMo 对话发生在两个具名真人之间；适配器将 `speaker_a` → user、`speaker_b` → assistant，每行保留真实说话人前缀，并把每个 session 的日期锚定到首轮内容中（L0 捕获时间戳是"现在"，时间类问题必须能从内容中回答）。

新增基准（如 PersonaMem 或语料驱动的测试库）只需在 `datasets.ts` 中增加一个输出标准 `EvalDataset` 结构的适配器 — runner 与数据集无关。

## 参数

完整列表见 `npm run eval:memory -- --help`。常用参数：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `--dataset` | `synthetic` | `synthetic` 或 `locomo` |
| `--max-conversations` / `--max-questions` | 0（全部） | 低成本切片 |
| `--baseline` | `none` | `full-context` 增加一个以（尾部截断的）全文作答的 no-memory 对照 |
| `--gateway-url` | — | 复用已运行的 Gateway 而非自行拉起；数据隔离由调用方负责 |
| `--port` | 8437 | 自行拉起 Gateway 的端口 |
| `--settle-timeout-s` | 600 | 每个对话等待管线排空的上限 |
| `--dry-run` | — | 只解析数据集并打印计划 |

回答/裁判模型默认取 `TDAI_LLM_MODEL`，可用 `TDAI_EVAL_ANSWER_MODEL` / `TDAI_EVAL_JUDGE_MODEL` 分别覆盖。用比回答模型更强的裁判模型是常见且低成本的准确率改进。

## 注意事项

- 分数依赖提取/回答/裁判模型；只应对比元数据块一致的运行（或差异正是你要测的变量）。
- 评测用 Gateway 配置缩短了管线定时器（如 `l2DelayAfterL1Seconds: 3`）使运行在秒级完成；生产默认值给足空闲时间行为一致，但本工具不度量时序敏感行为。
- `--gateway-url` 模式下所有对话共享同一记忆库，召回可能互相污染；正式评分请用默认的独立拉起模式。
- LLM 裁判并不完美；引用数字前请抽查 `report.json`。
