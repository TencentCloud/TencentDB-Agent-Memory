# 工具描述路由评测

本目录提供可直接运行的 LLM 评测源码、297 条固定样本及已完成的对照结果，用于评估 injector 描述是否让模型正确识别和调用工具，不评价工具返回资产的业务效果。

## 快速复现

从仓库根目录开始，需要 Node.js 22+：

```bash
cd MemoryProxy
npm ci
npm run eval:tool-routing:dry
```

该命令校验数据和结果的 SHA-256，构造全部 594 个原版／候选版首轮请求，并使用保存的逐调用核查重新计算主要指标。当前版本的预期输出：

```json
{
  "cases": 297,
  "recorded_runs": 594,
  "baseline_request_matches": 297,
  "current_candidate_request_matches": 297,
  "saved_metrics_verified": true
}
```

真正运行模型还需要 macOS 的 `sandbox-exec` 和 Python 3.14。历史运行使用 Python 3.14.7；脚本会记录本机 Python 身份。将以下配置写入已被 Git 忽略的 `.env.tool-routing.local`：

```dotenv
TOOL_ROUTING_API_URL=https://api.deepseek.com/chat/completions
TOOL_ROUTING_API_KEY=replace-me
TOOL_ROUTING_MODEL=deepseek-v4-flash
TOOL_ROUTING_THINKING_MODE=disabled
SKILL_VIEW_MODE=name
```

先运行一个场景的原版／候选版对照，Python 路径按本机安装位置替换：

```bash
npm run eval:tool-routing -- --live \
  --case public300-c6a79c582edee9c0 --variant both \
  --python /opt/homebrew/bin/python3.14 --budget 0.10 \
  --out scripts/eval/tool-routing/results/local-one.jsonl
```

运行全部 297 条样本、两版各一次：

```bash
npm run eval:tool-routing -- --live --all --variant both \
  --python /opt/homebrew/bin/python3.14 --budget 10 \
  --out scripts/eval/tool-routing/results/local-full.jsonl
```

`--variant` 支持 `baseline`、`candidate`、`both`，默认 `candidate`。运行串行执行，每个场景每版一次，最多 12 个模型响应，每次输出上限 8192 tokens，关闭思考，temperature=0、top_p=1。`--budget` 是按脚本保守估算的美元预算上限，不是实际账单。输出路径必须不存在；遇到任务错误即停止，已产生的记录保留。再次运行请指定新的输出路径。

输出 JSONL 保存请求指纹、模型响应历史、工具调用、执行进展、usage 和终止原因；相邻的 `<out>.report.json` 给出运行配置、计划／实际记录数及评分。新输出默认被 Git 忽略。

## 目录与执行方式

| 文件 | 用途 |
| --- | --- |
| `run.ts` | 模型请求、多轮执行与报告入口 |
| `prompts.ts` | 构造原版和当前候选请求 |
| `scorer.ts` | 工具选择、有效调用、误调用及编码活动计分 |
| `dataset.jsonl` | 297 条场景及预期行为 |
| `fixtures/text.json` | 样本引用的长文本，包括代码、测试、文档和工具返回 |
| `fixtures/layout.txt` | 固定评测请求布局 |
| `fixtures/licenses/` | 公开素材来源、版本及许可证 |
| `baseline/` | 固定的优化前描述模板 |
| `manifest.json` | 基线 commit、数据和历史结果哈希 |
| `results/` | 历史汇总、逐场景记录、恢复关系和 token 探针 |

样本中的 `$fixture` 引用由加载器自动展开，并校验文本哈希。所有必需素材以普通文本存放在仓库内，不需要解压归档或访问作者机器。

原版描述固定于 `97f94654280b2932c35ba4806a491999ed244cc9`；候选描述直接调用工作区中的四个 injector renderer，当前为使用 `<curl_recipe id="…">` 的 C4。两版使用相同的上下文、工具定义和执行环境。评测直接构造请求，不经过生产注入流水线，因此结果范围是描述路由能力。

模型通过原生工具在临时工作区读取、修改文件和执行受 sandbox 限制的 Bash；识别到的云工具 curl 由固定 fixture 返回结果，不访问生产资产。`workspace-host.ts`、`fixtures.ts`、`protocol.ts` 等保留这一执行过程。`npm test` 中包含请求指纹检查，以及在满足 macOS/Python 路径条件时运行的模拟模型工作区读取测试。

以后修改候选描述时，`current_candidate_request_matches` 可以减少，表示输入已不同于历史 C4；原版请求仍必须全部匹配。输入一致也不能保证模型再次输出完全相同。

评测入口默认固定 `SKILL_VIEW_MODE=name`，与冻结样本和历史 C4 保持一致。合并目标分支后，生产默认已改为按 `skill_id` 读取（`SKILL_VIEW_MODE=id`）；历史成绩不覆盖这个新默认模式。

## 数据和历史结果

共 297 个场景：118 条应调用正例（Memory 38、Skill 40、Knowledge 40），89 条信息已充分的边界负例（29、30、30），90 条 coding 负例。两版共 594 条观察记录。观察窗口结束不代表任务成功完成。

数据来自公开合成记忆、论文问答、基于公开工作流编写的请求和真实 issue 改编。coding 中 60 条为 CPython 修复，30 条为另外 12 个项目的限定代码审查。它们不是线上真实流量，也不是原 SWE-bench 得分；部分工具入口缺少充分独立覆盖。语义核查由助手完成，不是人工双审。

| 指标 | 原版 | C4 |
| --- | ---: | ---: |
| 工具描述及包装 tokens | 4,304 | 2,281（减少 47%） |
| 应调用时有效调用 | 118/118 | 118/118 |
| 首个云工具选择正确 | 118/118 | 117/118 |
| 已有充分信息仍误调用 | 71/89 | 24/89 |
| coding 误调用 | 0/90 | 0/90 |
| 正例有额外调用，包含重复读取完整资料 | 67/118 | 67/118 |

没有满足全部预设验收条件。既定编码活动检查未满足为 33/90 → 38/90；该检查不是代码正确率。达到响应／输出限制的记录为 69/297 → 64/297。仅按工具及参数规则计分，正例额外调用为 24/118 → 28/118；加入重复读取的语义核查后两版均为 67/118。新运行的报告只自动计算工具及参数规则，不自动进行新的语义核查，不能将其额外调用指标直接与表中的语义核查指标混用。

- [summary.json](./results/summary.json)：历史汇总及验收限制。
- [per-case.jsonl](./results/per-case.jsonl)：594 条逐场景证据，含调用、进展、终止原因、usage、请求指纹和与调用哈希绑定的语义核查。
- [recoveries.json](./results/recoveries.json)：历史中断与恢复的关联。
- [token-probe.json](./results/token-probe.json)：固定探针请求和原始 usage。

逐场景证据省略了长对话正文和最终回答；完整原始对话及中断日志另行归档，不是本目录的复现依赖。复跑会生成新的完整对话记录。已有结果由原始执行、中断延续和补跑合并得到，不能理解成一次不中断的完整运行。再次使用该数据集不构成新的独立测试集。

## 复测 token 差异

以下命令重放保存的六个固定历史探针请求：

```bash
npm run eval:tool-routing -- --live --probe-tokens --budget 0.10 \
  --out scripts/eval/tool-routing/results/local-token.json
```

探针包含原版、C4 和移除工具描述的对照输入；用前两者分别减去对照的 prompt tokens，计算描述及包装的边际开销。47% 是该开销的减少，不是整个请求的 token 减少。此命令使用保存的历史输入，不会随当前 renderer 修改而更新。历史受控缓存观察不能作为当前生产调用链或线上缓存命中率的验收。
