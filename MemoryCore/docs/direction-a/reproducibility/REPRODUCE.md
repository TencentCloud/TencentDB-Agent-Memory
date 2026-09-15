# R1 Reproduction

R1 是从包内冻结证据重建最终分析的零 provider 路径，不会调用模型提供商、Harbor 或 Docker。
本仓库保留 portable 脚本、冻结输出和 clean-directory 验证记录；完整 R1 输入位于最终提交包。
公开 PR 按公开边界不包含 raw trajectory、provider payload、prepared-tasks 和 provenance-only 文件。

预期关键结果：81/81 bindings；treatment fidelity 为 `PASS_WITH_LIMITATION`；scientific status 为 `PARTIALLY_SUPPORTED`；theta 前缀序列为 `0, 0, 0, 0, 0.056501547988`；Proposed 的 V/G 为 `0.011300309598` / `0.002260061920`；相对两个 comparator 的 DeltaV/DeltaG 均为 0/0。

R2 是付费全量重跑路线，只作方法说明，不属于本包的验收执行范围。
