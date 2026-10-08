# Pi durable outbox（#1391）

当前交付的是可独立运行和测试的投递组件，**尚未接入 Pi 自动捕获流程**。
导入模块不会启动后台任务，不会改变现有代理的保存路径。没有修改 `handler.ts`
或 `session/codebuddy/init.ts`，没有把 #1142 的服务端实现合入本分支。

## 组件

| 文件 | 职责 |
| --- | --- |
| `pi-outbox-store.ts` | 请求快照、原子领取、续期、落盘重试状态、死信和重新投递 |
| `pi-outbox-sender.ts` | 发送固定请求，严格检查网关回执，分类错误 |
| `pi-outbox-worker.ts` | 自动续期、超时、退避重试、次数上限、停止和恢复 |
| `pi-outbox-cli.ts` | 本地查询、单条死信重新投递、一次补发或持续发送 |
| `__tests__/pi-outbox-cli-crash.test.ts` | 实际 run 命令强杀、租约到期恢复和 ACK 后再强杀测试 |
| `scripts/pi-outbox-contract.ts` | 对接独立 #1142 checkout 的真实 HTTP/SQLite 崩溃测试 |

## 调用方式

以下示例由未来接入层调用；当前不替 Pi 选择生命周期事件或生成回合编号。

```ts
const store = new PiOutboxStore(privateQueueDirectory);
const input = preparePiOutboxInput(
  { serviceId, teamId, agentId, userId, sessionId },
  { key: turn.key, messages: turn.messages },
);
await store.enqueue(input); // 此处成功后，才可报告本地已可靠排队
const sender = createPiOutboxSender({
  endpoint: gatewayBaseUrl,
  idempotencyContract: "1142", // 部署者已确认能力；不是开启服务端能力的开关
  resolveApiKey: scope => credentialFor(scope.serviceId),
});
const worker = new PiOutboxWorker(store, sender);
await worker.flush(); // 一次有界补发，返回成功/重试/死信/丢失租约/本地错误统计
// 或：await worker.run(shutdownSignal, result => report(result));
```

`preparePiOutboxInput` 将 `turn.key` 原样放入 `idempotency_key`。每次发送落盘的
原始 JSON 字节，不重新生成时间戳、编号、身份或内容。每次 enqueue 会产生新的
本地 UUID；不会替调用方推断两个事件是否属于同一回合。

输入必须符合网关单次请求限制：1–100 条 user/assistant 消息，每条内容 1–8192
个 JavaScript 字符。超限会明确拒绝排队，不截断或静默丢弃。完整 Pi 对话如何归一化、
大回合如何拆分并分配稳定编号，留给尚未确定的捕获接入层。

## 本地操作命令

在 `MemoryProxy` 目录运行。目录必须指向该服务专用的 outbox，不能指向普通项目目录。

```powershell
# 查询状态、重试次数、下次可处理时间和错误类别
npm run outbox:pi -- list E:/private-data/pi-outbox
# 对指定死信恢复一轮新的重试预算；保留原编号和内容，不直接发送
npm run outbox:pi -- redrive E:/private-data/pi-outbox <record-id>
# 已确认网关部署了 #1142 或等价契约之后，才配置并执行补发
$env:TDAI_OUTBOX_ENDPOINT = 'http://127.0.0.1:8420'
$env:TDAI_OUTBOX_API_KEY = '<由本地凭据配置提供，不写入代码或队列>'
$env:TDAI_OUTBOX_IDEMPOTENCY = '1142'
npm run outbox:pi -- flush E:/private-data/pi-outbox
# 持续发现新记录并按持久化的退避时间重试，Ctrl+C 安全停止
npm run outbox:pi -- run E:/private-data/pi-outbox
# 可选：修改扫描间隔，单位毫秒；默认 1000，范围 1–86400000
npm run outbox:pi -- run E:/private-data/pi-outbox --poll-ms 500
```

查询只输出记录编号、文件名、状态、次数、时间和错误类别，不显示对话内容或认证信息。
损坏文件会单独报告并保留，不会挡住健康记录。临时 `.tmp` 文件不视作已排队记录。

`flush` 一次最多处理 100 条当时已到期记录，不会等待未来重试时间。
exit 0 表示此操作成功且补发后队列为空；exit 2 表示仍有待处理/死信/损坏记录、
发送失败或中断；参数、本地 I/O、配置错误返回 1。`list` 正常查询返回 0，发现损坏
记录返回 2；`redrive` 未找到对应有效死信返回 1。

`run` 启动后不会因队列为空或某条记录进入死信而退出，每轮最多处理 100 条到期记录。
重试沿用原有次数上限和退避时间；`--poll-ms` 只改变扫描频率，不加速尚未到期的重试。
输出 JSON 行：`started` 表示启动，`pass` 报告有处理结果或异常的一轮，`stopped`
报告停止后的待发送、租约、死信、最后一轮本地处理错误和损坏记录状态。
空闲轮次不重复输出日志。

收到 SIGINT（Ctrl+C）或 SIGTERM 后，取消在途发送、等待 worker 收尾，然后退出。
正常停止返回 0，即使仍有未确认记录；这些记录保留在磁盘上，下次启动继续处理。
停止检查发现死信、损坏记录或最后一轮本地处理错误返回 2；配置错误、无法扫描目录等
导致循环无法继续的本地 I/O 错误或输出失败返回 1。
exit 0 在 `run` 中表示服务正常停止，不能作为队列已清空的证明；需要检查 `stopped`
状态或使用 `list`。强杀无法执行收尾，重启后仍需等待旧租约到期再接管。
独立命令仍不捕获 Pi 对话，也不自动挂到 Proxy 启动流程。

原因：`network` 网络异常；`timeout` 超时或取消；`server` 服务端错误；`auth`
认证失败；`conflict` 同编号不同内容；`rejected` 其他拒绝；`malformed` 回执不完整；
`exhausted` 多次中断领取已消耗尝试预算。先修复对应原因，再 redrive。
不要靠换一个编号来绕过 conflict，否则可能重复保存。

## 状态和并发保证

请求写到私有临时文件，flush 文件后，原子改名发布为 `<id>.json`。领取时直接移动
记录文件，生成带随机 token、到期时间、尝试次数的 `.lease` 文件。续期生成新 token，
避免旧目录快照抢走已续期任务。每次领取都在发送前持久化增加尝试次数。

重试通过一次原子改名转为 `.pending`，文件名携带次数、下次时间和错误类别；
永久失败或用尽预算则转为 `.dead`。重启不会丢失预算或绕过退避时间。
续期、确认、释放和死信操作只操作当前租约文件；失去所有权返回失败，不能删除新持有者的记录。

默认：租约 30 秒，每 10 秒续期；发送超时 20 秒；最多 8 次领取；重试从 1 秒
指数增加，最大 5 分钟。进程在领取后、实际发送前崩溃，也消耗一次尝试，防止反复
崩溃的任务永久占据队列。人工 redrive 明确重置这轮预算。

worker 串行处理自己的续期和收尾，停止时取消在途请求并保留未确认记录。
自定义发送器应遵守 AbortSignal；即便不遵守，worker 也在超时后停止等待，
且不会让迟到结果删除新租约。`run()` 的调用方应提供状态回调并 await 停止结果。

Windows 并发 rename 可能都成功，因此 Windows 的领取、续期、释放、死信、redrive
和 ACK 额外使用 Node 内置 SQLite 的进程间写锁串行化。锁文件为队列目录中的
`.pi-outbox-lock.sqlite`，不保存对话、凭据或租约状态；进程崩溃由操作系统释放锁，
无需等待锁文件 TTL。锁争用时异步等待，最多 20 秒后明确报错，不阻塞同进程另一
个操作的收尾。原有记录格式、租约 token、退避和恢复逻辑不变。

Windows 需要支持 `node:sqlite` 的 Node 22+ 运行时，本机已在 22.23.2 验证；不能
禁用该内置模块。Node 22 可能输出 SQLite experimental warning，属于已知运行时
提示。Linux 保留原来的文件状态切换实现，不加载此模块。
锁文件及其 journal/WAL/SHM 是保留的内部文件，`list` 不把它们作为损坏记录。
运行期间不要手动删除或替换锁文件，否则不同进程可能失去共同的互斥对象。

## 边界

- 使用同一主机、支持同目录原子 rename 的本地文件系统，不承诺网络文件系统行为。
- 多个消费者必须使用这一套 API；直接编辑队列文件不属于支持的运维方式。
- 租约不能撤销已经发出的 HTTP 请求。暂停过久的旧进程仍可能产生重复请求，
  最终由 #1142 的服务端幂等能力防止重复入库。
- 同一队列固定用于同一网关数据域。不要更换 endpoint 指向另一个数据库后直接重放。
  认证密钥发送时解析，不保存在队列。目录包含会话原文，需配置私有权限，
  POSIX mode 不能代替 Windows ACL。
- 覆盖成功 enqueue 后的进程崩溃；不承诺所有操作系统突然断电后的目录元数据持久性。
  磁盘满、无写权限等 enqueue 失败必须明确报告。
- 租约采用主机墙钟；时钟跳变会提前或延后接管。网关幂等仍是最终去重保障。
- 回执成功表示原始对话已持久化，不代表 L1/L2/L3 已生成。#1142 服务端 pending
  pipeline outbox 的恢复消费者不在本任务范围内。

## 验证命令

```powershell
npm run test:pi-outbox
npm run typecheck:pi-outbox
npm test
# 单独 checkout #1142 并安装其 MemoryCore 依赖后：
npm run test:pi-outbox:contract -- E:/java/pr1142-outbox-contract-test/MemoryCore
```

契约脚本启动 loopback HTTP 服务，调用 #1142 实际的 conversation handler 和 SQLite
store；不启动完整生产网关的认证、配额和模型服务。故障注入发生在实际 handler
完成写入和 pipeline 通知之后，不用模拟成功写入替代数据库。覆盖以下场景：

| 场景 | 实际请求次数 | 最终断言 |
| --- | --- | --- |
| 收到成功回执、本地 ACK 前强杀，重新打开数据库并恢复 | 2 | 原回执、2 条 L0、1 次 pipeline 通知 |
| 同一 key 改变内容 | 1 次冲突请求 | HTTP 409、进入 DLQ，原 2 条 L0 不变 |
| 服务端已提交，但客户端收不到回执并超时，再重试 | 2 | 原回执、2 条 L0、1 次 pipeline 通知 |
| 两个独立进程看到同一记录后同时领取 | 1 | 只有一个进程投递成功，另一个无租约丢失错误 |
| 两次回执丢失耗尽预算，进入 DLQ，再用 redrive 重投 | 3 | 保留原编号、key、请求字节，复用服务端已完成回执 |

每个成功场景直接查询 SQLite，检查只有 2 条 L0、1 条 completed 回执和 1 条
acknowledged pipeline outbox；同时核对重放请求原文、accepted_ids 和 receiptId。
并发场景用子进程屏障固定竞争时机，避免仅凭偶然运行成功判断领取安全。

超时夹具设为 1 秒，耗尽预算夹具设为最多 2 次；生产默认值不变。为避免等待退避
和租约到期，恢复子进程的测试时钟推进到持久化的可用时间之后。下面的实际 CLI
强杀测试另行验证正常时钟下的 30 秒租约恢复。Windows 还强杀持有内部 SQLite
写锁的子进程，确认另一个消费者可以继续领取和 ACK。

Docker 也可以验证同一脚本：使用本机 memory-core 镜像的运行时依赖，将 #1142 的
`MemoryCore/src` 只读挂载到 `/app/src`，本组件目录挂到 `/app/outbox/src/agent-adapters`，
scripts 挂到 `/app/outbox/scripts`，执行
`node --import tsx/esm /app/outbox/scripts/pi-outbox-contract.ts /app`。
无需外部网络，可用 `--network none --rm`，不要挂载生产数据目录。

`pi-outbox-cli-crash.test.ts` 属于普通测试套件，启动实际 `pi-outbox-cli.ts run`
子进程。在本机 HTTP 接收端收到请求、尚未返回回执时强杀，随后用同一目录重新
启动命令。测试等待默认 30 秒租约自然到期，不改文件名或测试时钟，因此需要约
30 秒。检查请求字节、编号、身份维度、持久化尝试次数和最终 ACK；ACK 后再强杀
并打开队列，确认记录没有恢复。Windows 和 Linux 都执行此测试。
这里的 HTTP 接收端是测试夹具；服务端数据库去重仍由上面的 #1142 契约测试验证。

## 暂不实施、需要对齐的接线

2026-10-07 补充完成 Windows / Linux Node 22 检查和真实 Pi 普通问答、read 工具调用。
结果、复现方法、DeepSeek 兼容配置及工具循环的重复问题记录见
[Pi / Node 22 实测记录](./pi-outbox-verification.md)。真实 Pi 验证使用现有捕获路径，
不表示已完成 outbox 自动接线。

本次验证记录（2026-10-06）：基线 `8b86874`，#1142 为 `a524c60`。
新增组件测试 43 项；MemoryProxy 整套测试 52 项通过；组件、测试和联调脚本的独立
类型检查通过。全仓类型检查存在 60 个错误：排除新增 outbox 文件后的基线检查与包含
这些文件的检查，错误输出完全一致；不在本任务中修改这些现有类型问题。
真实 #1142 契约脚本分别在 Windows Node 24.14.1 和本机 memory-core Docker 镜像内通过。
这些结果不代表已验证完整 Pi 自动捕获或完整生产网关部署。

1. 谁组装完整回合：Pi 插件还是代理侧？当前 `pi.ts` 没有完成回合的生命周期入口。
2. 从哪个稳定事件编号产生 turn.key，如何处理工具循环、重试与超长回合？
3. 如何让 Pi 改走可靠投递，同时避免现有代理路径另存一次，并遵守两个禁改文件约束？
4. 部署端采用哪个 #1142 版本，实际后端是否具有等价的原子幂等能力？

本机 Pi 已更新到 `ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba`，包版本 1.0.4。
`agent_settled` 在自动重试/压缩/排队续跑都结束后触发，但事件本身不携带 messages；
`turn_end` 提供 messageEntryId，却不等同完整用户活动结束。源码提供候选接入能力，
不等于维护者已经认可插件侧接入。本次不修改 Pi 源码或现有 Pi 插件。
