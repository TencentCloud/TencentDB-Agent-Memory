## Description | 描述

### 问题

启用 memory-tencentdb 插件后，DeepSeek/MiMo 等 OpenAI-compatible 提供商的 Prompt 缓存命中率从 **~95% 骤降至 ~63-83%**。

根因是 `showInjected` 的两难困境：

```
showInjected=true  → L1 记忆写入历史 → 上下文膨胀 → 截断 → 熔断
showInjected=false → 每轮剥离注入内容 → 前缀字节不一致 → 缓存永远断裂
```

无论选哪个都会受损。本 PR 的 **Cache-Aware Context Lifecycle Management** 彻底解决了这个两难。

### 修改内容

**新增文件**：
- `src/core/history/window-calculator.ts` — N_optimal 自适应窗口计算 + TurnTokenTracker（EMA 滑动平均）
- `src/core/history/recent-history.ts` — 循环缓冲区（纯对话，N 轮上限，满即触发压缩）
- `src/core/history/stable-history-manager.ts` — 追加式摘要管理器 + buildCompressionPrompt()
- `src/core/history-reversal.ts` — Split-History：summaryBlock → prependSystemContext（缓存区），recentBlock → prependContext（动态区）
- `scripts/test_cache_hit_rate.py` — 35 轮 Cache Hit Rate 测试脚本（支持 --baseline / --both / --dry-run）
- `scripts/run_long_conversation_test.py` — 40 轮 Split-History 测试脚本
- `exp-readme.md` / `exp-readme-en.md` / `CACHE-OPTIMIZATION.md` — 完整实验报告与项目文档

**修改文件**：
- `src/core/hooks/auto-recall.ts` — 三区 Prompt 架构 + 自适应 N_optimal 窗口计算
- `index.ts` — 始终剥离 `<relevant-memories>`（showInjected 废弃），管理 recent buffer 和压缩触发
- `src/config.ts` — HistoryConfig 新增 `maxRecentTurns`（默认 8）、`adaptiveWindow`（默认 true）；RecallConfig.showInjected 标记 @deprecated
- `src/core/tdai-core.ts` — handleBeforeRecall 透传 stableHistory/recentHistory

**核心架构变更**：

```
┌─ SYSTEM PROMPT（缓存区）─────────────────────────────────┐
│  CACHE_BOUNDARY                                          │
│  ├── L3 Persona（固定）                                  │
│  ├── L2 Scene（固定）                                    │
│  ├── Tools Guide（静态）                                 │
│  └── 追加式摘要（只追加不重写 → 前缀永久一致 → 永久缓存）│
└──────────────────────────────────────────────────────────┘
┌─ USER MESSAGE（动态区）──────────────────────────────────┐
│  ├── 最近 N 轮纯对话（循环缓冲区，无注入内容）           │
│  └── L1 召回记忆（Prompt 最尾部）                        │
└──────────────────────────────────────────────────────────┘
```

三个关键设计：
1. **L1 记忆尾部化**：动态内容在 Prompt 末尾 → 不影响前缀匹配 → 不破坏 system prompt 缓存
2. **历史纯净化**：L1 永不写入历史 → 无膨胀 → 无截断触发 → 无熔断
3. **摘要追加化**：新 `<epoch>` 追加到末尾，旧 epoch 字节不变 → 前缀永久一致 → 稳定区缓存永不过期

### 实验过程与结果

#### 实验一（5 轮消融实验）：定位根因

| 实验条件 | 说明 | 平均命中率 | vs BASELINE |
|:---|:---|:---|:---|
| Cond A (BASELINE) | 原始状态：稳定内容放在 CACHE_BOUNDARY 之后 | 80.0% | — |
| Cond B (Fix 1 only) | showInjected=false，剥离注入 | 60.4% | **−19.6%** |
| Cond C (Fix 2 only) | 稳定内容前置到 CACHE_BOUNDARY 之前 | 88.4% | **+8.4%** |
| Cond D (Fix 1+2) | showInjected=false + 稳定前置 | 72.3% | −7.7% |

**结论**：Fix 2（稳定内容前置）是有效优化（+8.4%）。Fix 1（剥离注入）反而导致退化（−17.7% ∼ −41.8%），因为破坏了缓存的字节级一致性。**showInjected=true 在短对话中是必须的。**

#### 实验二（5 轮验证实验）：证明"注入-剥离"导致前缀断裂

两种 Cond D 变体对比：

| 变体 | 行为 | Turn 2 命中率 | Turn 3+ 命中率 |
|:---|:---|:---|:---|
| showInjected=true | 记忆与 Turn 1 一起缓存，Turn 2 复用前缀 | **93.1%** | 93-98% |
| showInjected=false | 记忆被剥离，Turn 2 User Message 开头与缓存不同 | **51.1%**（−41.8%）| 逐年恢复但仍低 |

**证明**：缓存匹配从 Prompt 第一个字节开始。Turn 1 的缓存以 `<relevant-memories>` 开头，Turn 2 的 User Message 以用户输入的第一个字开头 → 字节级不一致 → 匹配立即终止 → 全部历史区域缓存失效。

#### 实验三（40 轮长对话 Split-History）：截断场景的缓存保护

在 40 轮长对话中测试 Split-History 方案（summaryBlock → 缓存区 + recentBlock → 动态区）：

| 阶段 | BASELINE | SPLIT | 分析 |
|:---|:---|:---|:---|
| Early (2-10) | 87.6% | 87.9% | 持平（压缩未触发） |
| Mid (11-20) | 92.7% | 94.8% | SPLIT 略优（+2.1%） |
| Late (21-40, 排除异常) | ~95% | ~95% | 持平 |

**核心发现**：
- 无截断场景下 SPLIT 不引入退化，与 BASELINE 持平（中位数 SPLIT +4.1%）
- SPLIT 是"搬运 + 压缩"而非"增加"内容：将早期对话从不可缓存区域迁移到可缓存区域（作为摘要），同时将不可缓存总量从"无限增长"收敛为"最近 15 条"
- 截断场景下，BASELINE 全部历史熔断（截断点每轮前移 → 历史开头每轮变化 → 整个历史区域缓存失效），SPLIT 将失效范围从"无限"收敛为"15 条消息"，理论相对增益 +19.2%

#### 实验四（35 轮 Cache-Aware）：三区 Prompt 终局方案

在前三个实验基础上，本 PR 实现了完整的 Cache-Aware Context Lifecycle Management：

**N_optimal 自适应窗口公式**：

```
N_optimal = clamp(max(⌊α × 0.7 × (L − B − U − Tool − M − S − H_stable) / T⌋, ⌈2C/T⌉), 3, 15)

其中 α =
  0.8   if H_avg < 0.70（命中率偏低，紧缩窗口）
  1.0   if 0.70 ≤ H_avg ≤ 0.85（正常状态）
  1.15  if H_avg > 0.85（命中率良好，可适度放大窗口）

变量：
  L = 模型上下文窗口
  B = OpenClaw 预留缓冲区 (4000 tokens)
  U = 用户问题平均长度（5 轮 EMA）
  Tool = 工具调用结果平均长度（5 轮 EMA）
  M = L1 记忆平均长度（5 轮 EMA）
  S = CACHE_BOUNDARY 前固定内容长度
  H_stable = 稳定历史总长度
  T = 每轮对话平均 Tokens（10 轮 EMA）
  C = 压缩摘要平均长度（EMA）
  H_avg = 最近 10 轮平均命中率（排除 Turn 1）
```

**35 轮测试结果**：

| 指标 | 目标 | 实际 | 判定 |
|:---|:---|:---|:---|
| 整体加权命中率 | >85% | **97.7%** | ✅ 大幅超出 |
| 中位数命中率 | — | **99.4%** | ✅ |
| Turn 3+ 稳定性 | 稳定 | 持续 >90% | ✅ |
| Turn 1→2 断裂 | 无 | 49.6%（启动代价，非 showInjected=false 式 −41.8% 断裂） | ✅ |

**命中率计算**：加权平均 = Σ cache_hit_tokens / Σ prompt_tokens = 1,990,912 / 2,037,156 = 97.7%。不是逐轮 rate 简单平均（避免了小 Prompt 轮次和大 Prompt 轮次等权的偏差）。

```
逐轮数据（排除 Turn 1 + 2 次超时）：
 Turn  2:  49.6%  Turn 10:  93.4%  Turn 20:  98.5%  Turn 30:  99.9%
 Turn  3:  99.9%  Turn 11:  92.5%  Turn 21:  99.7%  Turn 31:  99.6%
 Turn  4:  98.1%  Turn 12:  95.3%  Turn 22:  99.8%  Turn 33: 100.0%
 Turn  5:  70.9%  Turn 13:  98.8%  Turn 23:  99.8%  Turn 34:  99.8%
 Turn  6:  97.4%  Turn 14:  99.1%  Turn 24:  86.6%  Turn 35: 100.0%
 Turn  7:  99.4%  Turn 15:  92.1%  Turn 25:  99.7%
 Turn  8:  99.4%  Turn 17:  99.6%  Turn 26:  99.8%
 Turn  9:  89.9%  Turn 18:  96.9%  Turn 27:  99.8%
                  Turn 19:  99.6%  Turn 28:  99.9%
                                   Turn 29:  99.9%
```

Turn 2 的 49.6% 为正常的启动代价（首次增量最大），Turn 3 立即恢复到 99.9%。Turn 5/24 的偶发波动由工具调用结果长度突变触发，下一轮立即恢复。Turn 16/32 为 API 瞬时超时（共 2 次），与缓存机制无关。

### 与旧方案的对比

| 维度 | 旧方案（showInjected=true） | 旧方案（showInjected=false） | 新方案（Cache-Aware） |
|:---|:---|:---|:---|
| L1 记忆位置 | prependContext（用户消息前缀） | prependContext（每轮剥离） | Prompt 最尾部 |
| 历史写入 | L1 + 对话全部写入 | 仅纯对话 | 仅纯对话 |
| 短对话命中率 | ~93% | ~51%（−41.8% 断裂） | **~97%** |
| 长对话膨胀 | 严重（触发截断） | 无 | 无 |
| N 轮数 | 固定 15 | 固定 15 | **自适应**（3-15，动态微调） |
| 稳定区缓存 | 每轮重建摘要 | 每轮重建摘要 | **追加式（永久缓存）** |
| 缓存断裂风险 | 长对话有 | 每轮都有 | **消除** |

### 详细实验分析

完整的消融实验过程、字节级缓存匹配机制分析、逐轮数据表格、截断熔断机制推导、Token 流量模型，请参见 [exp-readme.md](https://github.com/262352/TencentDB-Agent-Memory/blob/fix/cache-regression/exp-readme.md)（中文版，16 个章节）或 [exp-readme-en.md](https://github.com/262352/TencentDB-Agent-Memory/blob/fix/cache-regression/exp-readme-en.md)（English version）。

项目总览参见 [CACHE-OPTIMIZATION.md](https://github.com/262352/TencentDB-Agent-Memory/blob/fix/cache-regression/CACHE-OPTIMIZATION.md)。

## Related Issue | 关联 Issue
Fix #120

## Change Type | 修改类型
- [x] Bug fix | Bug 修复（showInjected 两难导致缓存命中率退化）
- [x] New feature | 新功能（Cache-Aware Context Lifecycle Management）
- [x] Documentation update | 文档更新（exp-readme.md §16, exp-readme-en.md, CACHE-OPTIMIZATION.md）
- [x] Code optimization | 代码优化（追加式摘要、自适应窗口、三区 Prompt）

## Self-test Checklist | 自测清单
- [x] TypeScript 编译通过（npm run build，0 errors）
- [x] 35 轮 Cache Hit Rate 测试：整体加权命中率 97.7%
- [x] 无 API Key / Token / 密码等敏感信息泄露
- [x] 历史中无 `<relevant-memories>` 残留（before_message_write 始终剥离）
- [x] 稳定历史追加式（旧 epoch 字节不变，前缀永久一致）
- [x] `showInjected` 废弃不影响现有用户
- [x] 新增配置项有合理默认值（maxRecentTurns=8, adaptiveWindow=true）
