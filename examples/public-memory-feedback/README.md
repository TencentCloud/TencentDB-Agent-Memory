# 公开长对话反馈实验（E3-M17）

本例在原生 MemoryCore SQLite/FTS5 上检验有限检索预算能否从既有漏检反馈中更新。旁路默认关闭；不修改 Gateway，不写用户记忆，不调用模型或外部判断服务。它补充原反馈写入研究的公开 L0 方法验证，不声称已实现自然用户的高置信意图识别。

最终数据为 LoCoMo 10 段完整历史、5882 条话语、114 个问题；45/24/45 个训练/开发/测试问题按 4/2/4 段对话隔离。查看 `PROTOCOL.md`、`PROTOCOL_R1.md`、`PROTOCOL_R2.md` 了解评分前约束与完整数据修订原因。原始数据不随代码许可证重新授权，下载器同时保存 CC BY-NC 4.0 原许可证。

## 安装与完整复现

需要 Python 3.11+（本例仅标准库）和 Node 22.16+。从源码根目录执行，选择一个不存在的新 `run` 目录。本机使用 Node 24.14.0；真实重建结果见交付索引。

```sh
cd MemoryCore
cp ../examples/public-memory-feedback/MemoryCore.package-lock.json package-lock.json
npm ci --ignore-scripts
node --import tsx --test src/core/feedback/retrieval-budget.test.ts ../examples/public-memory-feedback/fit.test.ts
node node_modules/typescript/bin/tsc --project tsconfig.public-feedback.json --noEmit
cd ../examples/public-memory-feedback
python -B -m unittest -v test_adapter
python -B download.py --output run/source
python -B prepare.py --input run/source/locomo10.json --output run/selected
python -B audit.py --input run/selected --output run/data
cd ../../MemoryCore
node --import tsx ../examples/public-memory-feedback/store-runner.ts collect ../examples/public-memory-feedback/run/data/inputs.json ../examples/public-memory-feedback/run/collect
node --import tsx ../examples/public-memory-feedback/fit.ts ../examples/public-memory-feedback/run/collect/rows.jsonl ../examples/public-memory-feedback/run/data/labels.json ../examples/public-memory-feedback/run/policy.json
node --import tsx ../examples/public-memory-feedback/store-runner.ts test ../examples/public-memory-feedback/run/data/inputs.json ../examples/public-memory-feedback/run/test ../examples/public-memory-feedback/run/policy.json
cd ../examples/public-memory-feedback
python -B analyze.py --rows run/test/rows.jsonl --labels run/data/labels.json --output run/analysis
```

如果交付包已有 `locomo10.json` 和许可证，可以从该文件执行 prepare，跳过下载。依赖安装完成后，prepare、audit、collect、fit、test、analyze 全程离线，模型和 HTTP 调用均为 0。需要完整原反馈 SDK 链的工程演示，请使用相邻 `../feedback-selfopt/` 的独立说明。

可重现的效果字段：阈值 0，approved=false，测试基座/候选/部署模式均 27/45（60.00%）；固定 12 条为 29/45（64.44%）。候选探索多了一次检索却没有改善，开发门拒绝采用。随机墙钟时间不承诺逐位一致；采集了 5 次顺序轮换计时，不能作为 225 个独立效果样本。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `prepare.py` | LoCoMo 到通用输入/独立标签的适配、版本检查、确定性分集、结构过滤 |
| `audit.py` | 应用 6 项冻结的原文审查排除项，不读取方法分数，不补题 |
| `store-runner.ts` | 实际 L1 原文入库与逐字回读、原生 FTS、独立数据库、计时与回退测量 |
| `fit.ts` | 5 个候选的训练选择、开发采用门；测试标签不参与选择 |
| `analyze.py` | pass/fail/error 分离、配对/聚类统计、逐条失误与稳健性统计 |
| `../../MemoryCore/src/core/feedback/retrieval-budget.ts` | 与数据集无关的旁路接口、开关、单次辅助、超时与容量保护 |

## 开关、回退和上限

`retrieveWithBudget({baseline, expanded})` 不传 mode 时只调用 baseline 一次，直接返回原对象。`mode:'candidate'` 为明确探索；`mode:'adaptive'` 还要求经开发门通过的 `policy.approved=true`。非法策略、超时、辅助异常、条数/字节超限、重复 ID、异常分数或与基座前缀不一致时返回已取得的基座。基座本身抛错会原样传播，不能伪装为成功回退。

k=5 或 12；阈值 5 种；单条 8 KiB，总注入 64 KiB；每次至多 1 次辅助、100 ms、0 重试；全模块最多 4 个尚未完成的辅助。超时后仍未结束的任务占用槽位，超限调用以 busy 回退，不能无限积累。回调需要遵守 AbortSignal；本地同步数据库阻塞由宿主进程截止时间管理。无规则生成服务、无持久缓存。旁路运算时间和空间均 O(k)，索引成本由原版 FTS 决定。

## 移植到内部编程数据

替换 `prepare.py`，输出同构 `Collection`：项目/用户隔离集合、原文 Memory 的稳定 ID、会话和时刻、查询 ID 与内容；标签单独给出引用 ID 及 train/dev/test。内部数据按项目和用户分组，不能照搬生活对话分布或本场阈值。没有经过核实的证据标签时保持 unknown，不从编译失败推断长期偏好。

`retrieval-budget.ts` 只依赖 `{id, content, score}` 和两个只读回调，可以适配既有检索返回；回调负责真实鉴权、租户过滤和分数同尺度。`store-runner.ts` 当前按集合创建隔离 SQLite，不访问生产库。内部环境必须重估条数/字节上限、错误代价和采用门，重新划分数据；不能照搬本场 approved=false 的实验参数冒充已部署策略。

## 读数边界

返回条目是拟注入内容，没有问答模型实际消费证明。报告测量引用覆盖，未被引用的片段不是自动判定的错误记忆。L1 全量原文入库只是固定输入合同，不是抽取准确率或写入权限标注。`fit` 为校验读取了标签文件字节，但只访问训练/开发条目的标签进行参数选择；单元测试验证任意更换测试标签不改变候选。代码和本地复现不需要 MiniMax、RD-Agent、LangSmith 或私有镜像；历史真实模型结果作为单独冻结附件提供。
