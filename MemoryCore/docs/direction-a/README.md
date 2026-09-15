# 方向A：低成本、高置信的 Memory 效果评估

**项目**：TencentDB-Agent-Memory / MemoryCore  
**方向**：腾讯犀牛鸟开源人才计划 Topic 3 · 方向A  
**作者**：李姝瑾  
**日期**：2026-09-14

## 1. 项目简介

现有端到端任务评测能够回答 Agent 最终是否完成任务，但很难直接判断：

> 这次成功或失败，究竟是不是由 Memory 带来的？

本项目围绕这一问题设计并实现了一套两层评测框架：

1. **研究 / 审计层**  
   对同一冻结任务状态分别执行 `FULL` 和 `REMOVE`，只改变目标 Memory 是否可用，并以前 4 个技术上有效的配对差值均值构造连续因果参照。

2. **低成本评估层**  
   模型冻结后，只运行一次独立 `NORMAL` 轨迹，提取因果结果揭示前可获得的低成本特征，再由冻结评估器输出 Memory 效果得分并决定接受或弃权。

因此，昂贵的 repeated `FULL/REMOVE` 被限制在训练、校准和周期性审计阶段，而不是每个线上任务的默认成本。

---

## 2. 最终结果概览

### Mem2

在未参与源域模型训练的 untouched-69 数据上，所提方法与容量匹配基线在相同覆盖率下：

- `V`：0.43081 vs 0.39135
- `ΔV = +0.03947`
- 相对提升约 **10.08%**
- RMSE 下降约 **16.34%**
- MAE 下降约 **26.41%**
- Spearman 提高约 **0.222**

但 `ΔV` 的单侧 95% 下置信界仍略低于 0，因此结论保持为：

> **经验性正向，但尚未获得正式统计认证。**

### Mem2 → Evo 适配

目标域因果监督昂贵且样本较少，因此最终采用：

> **冻结 Mem2 源域基础模型 + 强正则 Evo 目标域残差**

最终冻结模型：

`A_FROZEN_SOURCE_RESIDUAL_RIDGE`

Post-T1 开发阶段稳定性检查：

- 胜出模型支持：7/8
- 特征组稳定：8/8
- 正则强度稳定：8/8

### Fresh held-out

最终 Fresh 留出测试包含：

- 5 个独立任务
- 20 个 fixed-4 配对
- 40 个因果实验臂

五个任务的因果效应为：

`0, 0, 0, 0, 0.056501547988`

所提方法、容量匹配基线和仅目标域对照方法都捕获了唯一正效应任务，因此最终：

- `V = 0.011300309598`
- `G = 0.002260061920`
- Proposed vs 两个对照：`ΔV = 0`, `ΔG = 0`

最终结论：

> **Fresh 跨环境优势未被证明（NOT DEMONSTRATED）。**

处理一致性审计结论为：

`PASS_WITH_LIMITATION`

整体机器可读科学状态为：

`PARTIALLY_SUPPORTED`

---

## 3. 项目主要贡献

本项目最终完成了：

- `NORMAL / FULL / REMOVE` 三类运行语义；
- 连续 fixed-4 Memory 因果参照；
- 技术无效与科学失败分离；
- 防删失与固定 pair-order 机制；
- Mem2 源域低成本评估器；
- Mem2 → Evo 低自由度残差适配；
- Fresh 因果结果揭示前模型 / policy 冻结；
- 日志、预算账本、SHA-256 binding 与恢复完整性机制；
- 零 API 调用的确定性结果重建；
- 9 个 public selected zero-provider tests；
- clean-directory portable R1 reproduction。

---

## 4. 目录说明

```text
.
├─ README.md
├─ 方向A_方案介绍与测试结论报告_李姝瑾_FINAL2.md
├─ 方向A_方案介绍与测试结论报告_李姝瑾_FINAL2.pdf
├─ 方向A_最终报告_图表/
├─ analysis/
├─ reproducibility/
├─ evidence/
├─ ../../src/evaluation/direction-a/
└─ ../../scripts/direction-a/
```

其中：

- 本目录的 `FINAL2` Markdown / PDF：最终方案介绍与测试结论报告；
- `../../src/evaluation/direction-a/` 与 `../../scripts/direction-a/`：方向A 最终实现代码与对应测试；
- `analysis/`：最终分析结果与重建脚本；
- `reproducibility/`：复现说明、测试清单和文件哈希；
- `evidence/`：最终结果对应的冻结证据与必要审计材料。

---

## 5. 推荐阅读顺序

如果只想快速了解项目，建议依次阅读：

1. `方向A_方案介绍与测试结论报告_李姝瑾_FINAL2.pdf`
2. 本 README
3. `analysis/FINAL_HELDOUT_ANALYSIS.json`
4. `analysis/FINAL_METHOD_METRICS.csv`
5. `analysis/FINAL_TREATMENT_FIDELITY_AUDIT.md`

如果需要查看完整技术实现，再阅读：

`../../src/evaluation/direction-a/`

---

## 6. 复现

### R1：零 API 调用结果重建

R1 用于核对最终 Fresh 结果，不需要重新调用模型服务商。

portable 脚本、已冻结输出和 clean-directory 验证记录保存在 `analysis/`。
完整 R1 需要最终提交包中的 allowlist 证据；本 GitHub 目录按公开边界不包含
raw trajectory、provider payload、prepared-tasks 和 provenance-only 文件。
因此，绑定这些 package-only 输入的 Fresh recovery closure test 不属于公开 selected surface；
公开可运行的 9 个测试以 `reproducibility/FINAL_TEST_MANIFEST.json` 和
`reproducibility/RUN_COMMANDS.md` 为准。

该 portable 脚本已经通过 clean-directory 验证，并保持与原最终分析脚本相同的科学结果。

主要重建内容包括：

- 20 个 Fresh 配对；
- 5 个独立任务的 fixed-4 因果效应；
- Proposed / Baseline / Target-only 的覆盖率；
- `V`、`G`、`ΔV`、`ΔG`；
- treatment-fidelity summary；
- 成本与完整性检查。

### 选定测试

具体命令请参考：

`reproducibility/RUN_COMMANDS.md`

和：

`reproducibility/FINAL_TEST_MANIFEST.json`

这些测试均为 zero-provider 测试，不需要重新执行付费实验。

### R2：完整付费重跑

完整重跑需要：

- 对应模型服务商配置；
- Harbor / Docker 环境；
- 冻结任务、模型、策略和授权绑定；
- 较高 API 成本。

因此 R2 只作为完整执行说明保留，不是导师核对最终数字的默认路径。

---

## 7. 最终结论边界

本项目最终结论分为三个层次：

| 层面 | 结论 |
|---|---|
| Measurement / engineering system | **SUPPORTED** |
| Mem2 源域模型价值 | **经验性正向，但尚未正式认证** |
| Mem2→Evo 适配 | **开发阶段证据支持稳定冻结** |
| Fresh 跨环境优势 | **NOT DEMONSTRATED** |
| 任意生产环境自动泛化 | **NOT CLAIMED** |

本项目不声称：

- Memory 在所有任务上都有效；
- Fresh 上所提方法显著优于基线；
- 当前结果已经泛化到任意生产环境；
- 公开 benchmark 结果等价于腾讯内部业务验证。

---

## 8. 成本说明

本项目严格区分：

- **研究 / 训练 / 因果审计成本**
- **模型冻结后的线上评估成本**

在 untouched-69 中：

- 线上形态评估平均成本约：`CNY 0.01043 / group`
- FULL/REMOVE 因果审计平均成本约：`CNY 0.08896 / group`

后者约为前者的 **8.5 倍**。

因此本方案的低成本价值在于：

> 用有限的高成本因果实验建立可信评估器，再把高频在线判断压缩成一次 NORMAL 轨迹 + 低成本特征 + 冻结模型推断。

---

## 9. 提交说明

本目录对应方向A 最终提交内容，主要包括：

1. 方案实现代码；
2. 测试代码；
3. 一份方案介绍 + 测试结论报告；
4. 最终分析与必要复现材料。

详细方法、实验过程、结果与限制请以：

`方向A_方案介绍与测试结论报告_李姝瑾_FINAL2.pdf`

为主。
