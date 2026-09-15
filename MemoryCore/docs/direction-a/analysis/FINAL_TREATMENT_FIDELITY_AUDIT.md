# Direction A Fresh treatment-fidelity audit

审计日期：2026-09-14  
审计对象：Fresh N9 engineering held-out，5 个独立 task cluster × 每任务 4 个固定 pair  
最终判定：`PASS_WITH_LIMITATION`

## 1. 判定含义

本判定允许把 40 个 canonical scientific arms 重建为 20 个 FULL−REMOVE 配对，并在“冻结的五任务 Fresh 样本、冻结的任务字节、冻结的执行 profile 与现存 runtime 证据”范围内作条件性因果解释。它不授权声称恢复 wrapper 的逐字节执行身份，也不授权把结论推广到未测试任务族、Q6、自然在线写入/检索或其他 provider/runtime。

`PASS_WITH_LIMITATION` 而非无条件 `PASS` 的原因只有 provenance 边界，不是发现了 treatment contamination：两个 causal host-recovery driver 没有进入原 request/runtime 的哈希绑定；当前 phase-3 supervisor 又是实验后的工程修订版；更宽的 Harbor 工具链二进制环境没有全量 content-address。现存 journal、job、trajectory、raw verifier 和 attestation 对恢复事实相互闭合，但不能反向补造未冻结的 wrapper 字节。

## 2. 审计方法

审计脚本 `analysis/scripts/rebuild_direction_a_final_analysis.mjs` 只做离线读取、哈希、join 和算术，没有发起 provider call、重新运行 FULL/REMOVE、重训模型、改变 accepted IDs、调阈值或追加实验。其判定顺序是：

1. 验证最终授权请求的 81 项 `requiredBindings` 与实际字节；验证 prepared manifest、run state、barrier、pre-Y policy seal、model-set freeze 的 canonical content hash。
2. 验证 738 条 execution journal 和 104 条 budget ledger 的序号、前向链接与事件哈希。
3. 对每个任务重新计算 NORMAL/FULL/REMOVE task tree hash，比较三个 arm 的 environment 与 native tests，并读取实际 instruction 和 treatment manifest。
4. 对每个 canonical arm，用 run state、journal start/finish、Harbor config、trial result、trajectory、raw verifier stdout 与 pair attestation 做唯一 join。
5. 只从 raw `test-stdout.txt` 中恰好一条 `CASE_SUMMARY` 提取 `total_cases`、`success_count`、`fail_count`；要求冻结分母相等且 `success + fail = total`。
6. 以原 pairIndex 1..4 重建 `D_gj = U_FULL_gj - U_REMOVE_gj`，不使用执行汇总中的 D 或 θ 作为结果来源；最后仅把重建值与 final summary 做一致性核对。

## 3. 明确通过的检查

### 3.1 Authority 与代码绑定

- [PASS] 最终请求中的 81/81 个绑定文件存在且 SHA-256 相符；其中 final transitive manifest 声明的 44-file source import closure 处于请求绑定链内。
- [PASS] request-bound `evo-fresh-paid-run.ts` 先完成 NORMAL barrier 和 pre-Y seal，再调度 Fresh causal Y；pre-Y seal 记录 `causalYDispatchCountAtFreeze = 0`。
- [PASS] 最终 model set 明确 `refitAfterFreshY = false`，pre-Y seal 的 `modelSetHash` 与冻结 model set 相符。
- [PASS] run state 为 `COMPLETE`；40 个 canonical causal arms、20 个完整 pair、0 个 live technical-invalid causal slot。

### 3.2 处理构造与唯一差异

- [PASS] 5/5 任务的 FULL instruction 含实际 `<memory_context>`；REMOVE instruction 不含该块。
- [PASS] 每个 FULL instruction 都以 REMOVE 的完整 target instruction 为精确后缀，因此目标要求没有被改写或截断；NORMAL instruction 与 FULL instruction 完全相同。
- [PASS] FULL treatment 的 `injectedCandidateHash` 等于冻结 `taskCandidateHash`；REMOVE 的 `injectedCandidateHash` 为 `null`。
- [PASS] 每任务三个 arm 的 environment tree hash 完全相同；native target tests tree hash 完全相同并匹配 prepared manifest。
- [PASS] provider/model、Terminus-2 scaffold、reasoning/Responses decoding、12-turn horizon 和 native verifier 在 40 个 canonical arms 中一致。

### 3.3 实际送达，而非只看准备文件

- [PASS] 40/40 个 canonical Harbor config 都指向该 arm 的冻结 prepared task 目录。
- [PASS] 40/40 个 trial result 的 `task_name`、task path 和 model 与 config/manifest 相符。
- [PASS] 40/40 个 trajectory 的首个 user message 都逐字包含对应 prepared instruction；所有 FULL trajectory 含 `<memory_context>`，所有 REMOVE trajectory 不含它。
- [PASS] 因而 treatment-fidelity 证据来自实际送达轨迹，不只是 `DIRECTION_A_TREATMENT.json` 的声明。

### 3.4 Pair、顺序、隔离和结果

- [PASS] 20/20 个 pair attestation 的 `scheduledArmOrder` 与 prepared pair schedule 一致；每个 pair 的首个实际启动 arm 符合 FULL_FIRST/REMOVE_FIRST。
- [PASS] 40/40 个 canonical arm 都有唯一 journal start、唯一 `VALID_RESULT` finish 和唯一 matching attestation；attestation 的 restored/frozen state、target spec、schedule、workspace isolation 与 journal start hash 闭合。
- [PASS] 40/40 个 raw verifier stdout 都含恰好一条可解析 `CASE_SUMMARY`，分母等于冻结 `frozenTotalCases`，账户恒等式通过。
- [PASS] 39 个 `SCIENTIFIC_FAILURE` 是有效的部分成功/未全通过科学观测，不是技术无效；1 个 `RECONCILED`（n5 pair 3 FULL）仍有完整 raw verifier 观测。没有把 scientific failure 改写为 technical invalid。
- [PASS] 离线重建的 20 个 D 和 5 个 fixed4 θ 与 final summary 在 1e-6 容差内一致。

## 4. 恢复与技术失败

存在两个 causal host-recovery canonical attempts：

| 位置 | 被替代的零 provider 技术中止 | canonical recovery | calls | CNY |
|---|---:|---|---:|---:|
| n3 pair 3 REMOVE | 1 | `fresh-n9-phase3-3-pair_3_remove-hostrecovery-1` | 12 | 2.405826 |
| n4 pair 3 FULL | 3 | `fresh-n9-phase3-4-pair_3_full-hostrecovery-1` | 12 | 1.495521 |
| 合计 | 4 | — | 24 | 3.901347 |

四次被替代尝试均为 Docker/buildx host 争用导致的零 provider、零科学观测技术中止；它们保留在 journal、sidecar 和 attestation 的实际启动顺序中，但不进入 FULL/REMOVE utility 的分子或分母。恢复没有创建 pair 5、没有改变 schedule、treatment、verifier、provider/model 或 prepared bytes。

另有一次 Phase 1 n3 NORMAL prefix-environment recovery。若把它与上述两次 causal recoveries 合计，所有 recovery attempts 共 36 calls、CNY 6.312528。该 NORMAL 恢复影响 Phase 1 特征观测与总成本，但不直接进入 20 个 causal pair。

## 5. 限制与裁决边界

1. 两个 causal recovery driver 的当前文件与时间线/记录相容，但未被 81 项 request binding 或 runtime hash 锁定；只能证明“这两个 recovery observation 被不可变 runtime 证据闭合”，不能证明“当前 driver 文件就是执行时逐字节文件”。
2. 当前 `evo-fresh-phase3-supervisor.ts` 是实验后工程修复版，不得放入 executed-exact 类别；科学 arm dispatch 的核心仍由 request-bound paid runner 与 core 实现约束。
3. Harbor/runtime 外部工具链未做到全二进制封存。40 个 arm 的 task/config/model/scaffold/horizon/verifier 均被实际证据约束，但跨机器逐字节复现仍取决于外部运行环境。
4. 本审计判断 treatment 是否被正确构造、送达和计分；它不把工程完整性自动升级为统计显著性或外部泛化。

## 6. 最终 treatment-fidelity 结论

没有发现 FULL/REMOVE 任务内容、native tests、执行 profile、实际 instruction delivery、pair 顺序、workspace isolation 或 raw outcome extraction 的处理污染。两个恢复 pair 也能用保留的失败记录、canonical recovery job、trajectory、verifier 和 attestation 唯一重建。因此，20 个 pair 可进入最终 held-out 点估计分析。

最终判定保持为：`PASS_WITH_LIMITATION`。
