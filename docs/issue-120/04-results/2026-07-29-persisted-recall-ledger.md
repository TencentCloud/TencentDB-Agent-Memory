# Persisted Recall Ledger：OpenClaw + DeepSeek 验收

## 结论

Append-only Persisted Recall Ledger 通过 Issue #120 的真实 provider
验收。候选的 pooled warm cache hit rate 为 **99.53%**，比 0.3.6
基线的 **71.36%** 提高 **28.17 个百分点**，且与此前测得的
plugin-inert **99.59%** 相差仅 **0.07 个百分点**。

这不是通过缩短 prompt 得到的比例改善：候选 6 个暖样本实际命中
**124,800 tokens**，比基线的 **88,192 tokens** 多 **36,608**；
候选暖 prompt token 总量反而略高（125,391 vs 123,585）。

## 固定环境

- OpenClaw：`2026.5.28`
- Provider/API：DeepSeek V4 Pro，`openai-completions`
- 基线插件：发布版 `memory-tencentdb@0.3.6`
- 候选源码基点：`846b5f3`
- Recall：keyword，固定 5 条合成 fixture，`maxResults=5`
- 每个变体 3 个独立 session，每个 3 轮；首轮冷样本排除
- 暖样本：每个变体 6 个
- 顺序：baseline-1 → candidate-1 → candidate-2 → baseline-2 →
  candidate-3 → baseline-3
- 每轮间隔：3 秒

所有 `result.json` 只保存用量、hash、marker 数量和上下文大小，不保存
prompt 正文或 API key。OpenClaw 的临时 home/state/workspace 在验收后删除。

## Pooled 结果

| 变体 | 暖样本 | Cache hit tokens | Cache miss tokens | Pooled hit rate |
|---|---:|---:|---:|---:|
| 0.3.6 基线 | 6 | 88,192 | 35,393 | 71.36% |
| Persisted ledger | 6 | 124,800 | 591 | 99.53% |
| Plugin inert（既有对照） | 6 | 109,824 | 447 | 99.59% |

逐 session 结果：

| 运行 | Hit tokens | Miss tokens | Hit rate |
|---|---:|---:|---:|
| baseline-1 | 29,568 | 11,651 | 71.73% |
| candidate-1 | 41,600 | 197 | 99.53% |
| candidate-2 | 41,600 | 197 | 99.53% |
| baseline-2 | 29,312 | 11,871 | 71.17% |
| candidate-3 | 41,600 | 197 | 99.53% |
| baseline-3 | 29,312 | 11,871 | 71.17% |

## 结构验收

benchmark 对相邻请求执行以下断言：

```text
hash(provider request N 的当前 user message)
  ==
hash(provider request N+1 中对应的历史 user message)
```

- 基线：`0 / 6` 相邻轮次通过。
- 候选：`6 / 6` 相邻轮次通过。
- 候选每个 session 的 turn 1 含 1 个 ledger、5 个
  `<memory-ref>`；turn 2/3 当前 user message 均为 0 个 ledger、0 个
  memory ref。历史中始终只有 turn 1 的同一个 ledger。
- 因此目标序列实际成立：

```text
Turn 1: A + U1+R1
Turn 2: A + U1+R1 + O1 + U2
Turn 3: A + U1+R1 + O1 + U2 + O2 + U3
```

## 自动测试

- `npm test`：6 files，82 tests 全部通过。
- 覆盖：重启后历史去重、ID/revision 更新、跨 ID 内容去重、string /
  multipart、XML 转义、50 轮稳定、32k cap、compaction 后重新注入、
  legacy strip、L0 原始文本 capture。
- `npm run build`、`npm run build:plugin`：通过。
- `npm run benchmark:prompt-cache:test`：2/2 通过。
- `npm pack --dry-run`：通过，151 files。
- `git diff --check`：通过。

在官方 `main@104e9d8` 上重新应用为 PR 单提交后，又执行了一次独立三轮
DeepSeek smoke：2 个暖样本共命中 41,472 tokens、miss 253 tokens，
hit rate **99.39%**；相邻轮次 transcript hash **2/2** 一致。该 smoke
用于确认主线前移未破坏修复，正式 3×3 统计仍以上述 99.53% 矩阵为准。

## 原始脱敏结果位置

工作区外层的本地运行目录：

```text
benchmark-runs/issue-120/deepseek-v4-pro/persisted-ledger/2026-07-29/formal/
├── baseline/
│   ├── run-1-valid/result.json
│   ├── run-2/result.json
│   └── run-3/result.json
└── candidate/
    ├── run-1/result.json
    ├── run-2/result.json
    └── run-3/result.json
```

这些运行产物保持 Git ignored。PR 中提交的是 benchmark 脚本、自动测试和本
报告，不提交本地密钥。
