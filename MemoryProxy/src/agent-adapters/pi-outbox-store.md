# Pi durable outbox（#1391）

Proxy 将 Pi 每次模型回复（包括工具调用回复）的记忆写入持久队列，再由后台发送。
默认关闭；Pi 客户端和插件无需修改。实现依赖 #1142 的网关幂等契约。

## 启用

在现有 Proxy 配置的 `tdai` 节点下添加，沿用已有 endpoint、apiKey、serviceId 和 memory 配置：

```yaml
tdai:
  piOutbox:
    enabled: true
    directory: /var/lib/memory-proxy/pi-outbox
    idempotencyContract: "1142"
```

目录必须是可写的绝对路径；Windows 例如 `E:/private-data/pi-outbox`。
Docker 挂载持久化本地卷，例如 `-v pi-outbox:/var/lib/memory-proxy/pi-outbox`。
同一队列固定对应一个网关数据域，不要更换 endpoint 后直接重放旧记录。
目录包含会话原文，应配置私有权限；POSIX mode 不能代替 Windows ACL。

`idempotencyContract` 是部署者对网关兼容性的确认，不会给旧网关增加去重能力。
启动时验证配置和目录可写性，并自动恢复、持续发送，无需另外运行 `run`。
API key 在发送时读取，不保存在队列中。新增捕获受原有身份、memory、writeL0、
extraction 和资产能力门控控制。关闭捕获不撤销已入队写入；关闭 `piOutbox.enabled` 停止自动消费。

`pi.ts` 构造专属 TdaiClient，现有 recorder 组装内容后转为本地 enqueue。
其他客户端和未启用时沿用直接写入。`index.ts` 管理消费者启停；正常关闭先停止接收新连接，
有界等待活动请求、在途保存和消费者收尾。重启使用原目录恢复。

## 操作编号与可靠性边界

服务端操作编号为 `pi.<请求 traceId>`，作为 `idempotency_key` 随请求持久化。
同一次本地保存重试复用已入队批次；投递重试、重启和 redrive 使用落盘原文及原编号。
独立请求即使文字相同也使用不同编号；客户端重新发起整个模型请求属于新操作，
不提供跨客户端 HTTP 重试去重。任务 ID 与身份维度保留。

长消息沿用 TdaiClient 的 8192 字符分块、每批 100 条限制，批次编号使用固定 `.0`、`.1` 后缀。
直接调用 store 的超限输入会拒绝；自动接入保留全部文本和 Unicode 字符。
多批次分别落盘，不提供跨批次全有或全无保证，也不承诺按对话发生顺序投递。

非流式回复等待本地 enqueue；流式内容照常转发，但 `[DONE]` 在 enqueue 成功后才释放。
磁盘写入失败使请求或流失败，不回退到直接写入；缺少完整结束事件的流不报告捕获成功。
可靠性从成功 enqueue 开始：入队前强杀或流中断的内容无法靠队列恢复，已展示文字不等于已保存。
文件发布前执行文件 sync；不承诺所有操作系统突然断电后的目录元数据持久性。

## 查询、重投与补发

在 `MemoryProxy` 下运行，目录指向该服务专用队列：

```powershell
# 查询状态、次数、下次可处理时间和错误类别
npm run outbox:pi -- list E:/private-data/pi-outbox
# 指定死信恢复一轮重试预算，保留原编号和内容；不直接发送
npm run outbox:pi -- redrive E:/private-data/pi-outbox <record-id>
# 确认网关兼容后，配置独立消费者
$env:TDAI_OUTBOX_ENDPOINT = 'http://127.0.0.1:8420'
$env:TDAI_OUTBOX_API_KEY = '<本地凭据>'
$env:TDAI_OUTBOX_IDEMPOTENCY = '1142'
# 一次补发，或持续发送（Ctrl+C 停止）
npm run outbox:pi -- flush E:/private-data/pi-outbox
npm run outbox:pi -- run E:/private-data/pi-outbox
# 可选扫描间隔，默认 1000 毫秒，范围 1–86400000
npm run outbox:pi -- run E:/private-data/pi-outbox --poll-ms 500
```

`list` 只输出元数据，不显示对话和凭据；损坏文件保留并报告，临时 `.tmp` 不算已排队记录。
`flush` 每轮最多处理 100 条到期记录。`run` 持续扫描，空队列或死信不使其退出；扫描间隔不改变退避时间。
`run` 输出 JSON 行 `started`、有处理结果或异常时的 `pass`、停止后的 `stopped`；空闲轮次不输出。
SIGINT/SIGTERM 取消在途发送并等待收尾，未确认记录保留；强杀后须等待旧租约到期。
独立命令只消费已有队列，自动捕获由 Proxy 负责。

| 命令 | exit 0 | 其他结果 |
| --- | --- | --- |
| `list` | 查询成功 | 2：存在损坏记录 |
| `redrive` | 成功恢复死信 | 1：未找到有效死信 |
| `flush` | 成功且队列为空 | 2：有剩余、死信、损坏记录、发送失败或中断 |
| `run` | 正常停止，可仍有未确认记录 | 2：停止时有死信、损坏记录或最后一轮本地处理错误 |

参数、配置及未被处理的本地 I/O 错误返回 1。`run` 的 exit 0 不代表清空，应检查 `stopped` 或 `list`。

错误类别：`network` 网络异常；`timeout` 超时/取消；`server` 服务端错误；`auth` 认证失败；
`conflict` 同编号不同内容；`rejected` 其他拒绝；`malformed` 回执不完整；`exhausted` 领取预算用尽。
修复原因后 redrive，不要换编号绕过 conflict，以免重复保存。

## 租约与恢复

store 先写私有临时文件并 sync，原子改名发布。领取直接移动记录为带 token、到期时间和
尝试次数的租约文件；续期更换 token。释放、确认、死信只操作当前租约，旧持有者不能删除新租约。
退避时间、尝试次数和失败类别写入文件名；永久失败或耗尽预算转为死信，redrive 重置预算。

默认租约 30 秒、每 10 秒续期、发送超时 20 秒、最多 8 次领取；重试从 1 秒指数增加，最大 5 分钟。
领取后发送前崩溃也消耗一次预算。worker 在停止或超时后不会用迟到结果确认新租约。
租约使用主机墙钟，跳变可能改变接管时间；租约也不能撤销已发出的 HTTP 请求，最终去重依赖网关。

Windows 的文件状态切换额外使用 Node 内置 SQLite 进程间写锁，崩溃自动释放；锁只协调切换，
不存储对话或租约状态。需要支持 `node:sqlite` 的 Node 22+，不能禁用该模块。
运行期间不能删除或替换 `.pi-outbox-lock.sqlite` 及其内部文件。Linux 使用文件原子切换。
队列支持同主机本地文件系统和使用同一套 API 的消费者，不支持网络文件系统共享或手动编辑记录。

成功回执表示 L0 已保存，不代表 L1/L2/L3 已生成；网关 pipeline outbox 恢复属于 #1142 的范围。

## 实现与验证

`pi-outbox-store.ts` 管理记录和租约；`pi-outbox-sender.ts` 严格校验回执；
`pi-outbox-worker.ts` 管理重试和续期；`pi-outbox-cli.ts` 提供运维入口。
`pi.ts` / `pi-outbox-runtime.ts` 接入保存和启停，`pi-outbox-stream.ts` 管理流式完成屏障。
独立组件的 `preparePiOutboxInput(scope, turn)` 将调用方的 `turn.key` 原样写入请求；
`store.enqueue(input)` 每次生成新的本地记录编号，不自行判断是否同一操作。

测试入口、固定版本、故障场景及验证限制见 [验证记录](./pi-outbox-verification.md)。
