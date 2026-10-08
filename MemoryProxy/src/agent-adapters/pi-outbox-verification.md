# Pi / Node 22 实测记录

验证日期：2026-10-07（Asia/Shanghai）。本记录区分现有 Pi 接入链路和新增 outbox
组件的验证；二者分别通过，不代表 Pi 已自动接入 outbox。

## 固定版本与工作目录

| 对象 | 实测版本 / 位置 |
| --- | --- |
| #1391 工作目录 | `E:/java/TencentDB-Agent-Memory-1391`，`codex/pi-durable-outbox` |
| 工作目录基线 | `8b86874a2daea49e3ff0fb53d699203146c5c77d`，包含当前未提交的 outbox 实现 |
| Pi 源码 | `E:/java/pi`，`ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba`，包版本 `1.0.4` |
| #1142 契约测试目录 | `E:/java/pr1142-outbox-contract-test`，`a524c609a84e41801d11cbedc77cf9718e9f3691` |
| Windows 验证运行时 | 官方便携版 Node `v22.23.2` |
| Linux 验证运行时 | 本机 MemoryCore / MemoryProxy Docker 镜像内 Node `v22.23.2` |
| 真实模型 | `deepseek-v4-flash`，实际请求 `https://api.deepseek.com` |

Windows Node 压缩包对照官方 SHASUMS256 校验成功，SHA-256 为：

```text
1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97
```

系统默认 Node 仍为 `v24.14.1`。全局 Pi `0.84.1` 没有用于本次验证；运行的是上述
Pi 源码及其 source resolver。没有更换全局运行时、修改用户日常 Pi 配置或提交 Pi 源码。

## Node 22 检查结果

| 检查 | Windows Node 22 | Linux Docker Node 22 |
| --- | --- | --- |
| MemoryProxy 全部现有单元测试 | 5 个文件、52 项通过 | 5 个文件、52 项通过 |
| outbox 组件、测试及脚本的独立类型检查 | 通过 | 通过 |
| #1142 实际 handler + SQLite 的崩溃重放契约测试 | 通过 | 通过 |

契约测试在网关已经接收、客户端尚未本地 ACK 的窗口强制结束发送进程，再重新打开
数据库并重放。两个平台均得到：

```json
{
  "passed": true,
  "requestsBeforeConflict": 2,
  "l0Rows": 2,
  "identicalAcceptedIds": true,
  "pipelineNotifications": 1,
  "conflictInDLQ": true
}
```

即重复发送没有新增对话记录，接收回执一致，pipeline 通知一次；同一个 key 搭配不同
内容时进入 DLQ。SQLite 的 experimental warning 不影响上述断言。

Windows Node 22 下全仓类型检查仍有 60 个错误。排除新增 outbox 文件后的基线检查
也是 60 个错误，错误输出完全相同。这说明本次未新增类型错误，但不能将全仓类型检查
标记为通过。

## 真实 Pi 接入验证

链路为：Pi 1.0.4 源码 → 现有 Pi 插件 → 当前 MemoryProxy 源码 → DeepSeek；
现有 Proxy recorder 将对话写入当前 MemoryCore。两次实测使用独立测试用户、team、
agent、会话和 SQLite 目录；通过公开查询接口检查 L0 原始对话及其身份、会话维度。

Proxy 使用正常 user key 认证，另测了错误 key 返回 401，没有使用强制身份开关。
Core 容器仅向本机 loopback 发布随机端口。验证关闭了 L1 提取和 skill capture，
Proxy 的会话状态使用 memory backend。测试采用本地部署模式，未启用 Core 的服务
共享密钥 gate；不据此声称生产部署的全部认证方式或后端都已验证。

### 普通问答

- 运行编号：`5bc300de`。
- 让模型只返回 `PI1391-5bc300de`；真实回复与要求完全一致。
- MemoryCore 查询到 2 条 L0 记录：一条用户问题、一条助手回复。
- 会话：`pi-01a11577-113c-769b-82c9-113e96cb3ea4`。
- 查询结果的 user / team / agent / session 均匹配本次新建的测试身份。

### 工具调用后继续回复

- 运行编号：`75d4b4a8`。
- 在独立测试目录创建 `smoke-fixture.txt`，文件内容为 `PI1391-75d4b4a8`。
  提示词只要求读取并回复文件内容，没有直接提供这个标记。
- Pi 的真实 `read` 工具执行成功，随后模型回复正确的文件内容。
- 共发生两次模型请求，均成功；MemoryCore 查询到 4 条 L0 记录。
- 会话：`pi-01a11578-ece3-756f-ba2d-53186fdf2b19`。

按两次模型请求对应的记录看，现有流程保存的是：

1. 用户问题 + 助手发起的 read 工具调用。
2. 同一条用户问题 + 助手最终回复。

因此，一次用户提问在工具循环中被保存了两遍。这是当前 recorder 的实测行为，
本次没有修改它。outbox 的重试去重只能防止同一投递被反复入库，不能自动决定这两次
模型调用是否应合成一轮。接线前仍需确认“完整回合”的单位、稳定 key 的来源，以及
如何避免新旧保存路径同时写入。

### 必需的模型兼容配置

未经兼容覆盖的首次真实请求失败：DeepSeek 返回 HTTP 422，不接受消息角色
`developer`。当前 Pi 的 provider 名称为 `tdai`，请求地址为本机 Proxy，因此本次
通过独立测试配置显式关闭该角色，随后普通问答和工具调用均通过：

```json
{
  "providers": {
    "tdai": {
      "modelOverrides": {
        "deepseek-v4-flash": {
          "compat": { "supportsDeveloperRole": false }
        }
      }
    }
  }
}
```

该配置写入隔离的 `PI_CODING_AGENT_DIR/models.json`，未改插件或用户的日常配置。
结论是“带此配置的当前 Pi + DeepSeek 已跑通”，不能说原样默认配置也已跑通。

## 复现与证据

本机验证文件保留在：

```text
C:/Users/小米/AppData/Local/Temp/pi-outbox-1391-node22-20261007
```

其中 `windows-node22-tests.log` / `docker-node22-tests.log` 保存单元测试结果；
`windows-node22-contract.log` / `docker-node22-contract.log` 保存崩溃重放结果；
`windows-node22-full-types.log` / `windows-node22-baseline-types.log` 保存类型错误对比。
两次成功的真实 Pi 运行各自位于 `real-pi-5bc300de` 和 `real-pi-75d4b4a8`，包含
`report.json`、Pi / Proxy / Core 日志及隔离的会话文件。日志与展示配置中的密钥已脱敏，
测试数据库、运行配置和临时文件不加入 Git。

以下命令在 `E:/java/TencentDB-Agent-Memory-1391/MemoryProxy` 执行：

```powershell
$node22 = 'C:/Users/小米/AppData/Local/Temp/pi-outbox-1391-node22-20261007/node-v22.23.2-win-x64/node.exe'
& $node22 node_modules/vitest/vitest.mjs run
& $node22 node_modules/typescript/bin/tsc --noEmit -p tsconfig.pi-outbox.json
& $node22 --import tsx/esm scripts/pi-outbox-contract.ts E:/java/pr1142-outbox-contract-test/MemoryCore
```

真实 Pi 的隔离启动、身份创建、结果查询和清理由本机临时脚本 `run-real-pi.mjs` 完成。
它读取本机已有部署配置中的模型凭据；重新运行会真实请求模型并产生相应费用：

```powershell
$validationDir = 'C:/Users/小米/AppData/Local/Temp/pi-outbox-1391-node22-20261007'
& $node22 "$validationDir/run-real-pi.mjs"
& $node22 "$validationDir/run-real-pi.mjs" --tools-smoke
```

脚本运行 Pi 的核心参数为：

```text
node --import file:///E:/java/pi/packages/coding-agent/src/experimental/source-resolver.ts
  E:/java/pi/packages/coding-agent/src/experimental/cli.ts
  --no-extensions -e E:/java/TencentDB-Agent-Memory-1391/MemoryCore/pi-plugin
  --provider tdai --model deepseek-v4-flash --thinking off
  --tools read --mode json -p <测试提示词>
```

普通问答案例禁用了工具。首次源码运行缺少 provider 数据缓存，已在 Pi 的
`packages/ai` 下运行 `scripts/generate-models.ts --strict --data-only` 补齐忽略文件，
并通过 `check-model-data.ts` 检查；Pi 的 Git 工作目录仍干净。

## 尚未覆盖及清理

- 未实现、未验证 Pi 自动 enqueue 到 outbox 的完整链路；仍保留原来的正常捕获路径。
- #1142 的实际 handler / SQLite 契约单独通过，不等于完整 Pi + outbox + 生产网关通过。
- 未验证 L1 / L2 / L3 记忆生成、私有计费报告服务、生产共享密钥配置或其他存储后端。
  本地 CREDIT_REPORT 服务未启动，其失败日志不影响已独立查询确认的 L0 写入。
- 测试 Core 容器和 Proxy 进程已结束，随机测试端口已关闭；原有 Docker 服务保留。
- 未修改 `handler.ts`、`session/codebuddy/init.ts` 或现有 Pi 插件。
- 验证执行时没有提交、推送或创建 PR。后续将实现、测试和文档按功能整理为本地提交，
  提交记录见当前分支的 `git log`；未推送。报告保存于 #1391 工作目录，旧 #1070
  工作目录未改动。

## 持续发送命令补充验证（2026-10-07）

新增 `run <directory> [--poll-ms <milliseconds>]`，直接复用 worker 的持续循环。
正常停止后保留未确认记录，并输出最终队列状态；死信、损坏文件或最后一轮本地处理
错误会通过状态和退出码报告。具体配置和退出码见 [使用说明](./pi-outbox-store.md)。

新增 9 项命令测试覆盖：启动后新增记录、503 后按退避时间原样重试、持续运行中的
死信重新投递、取消在途 HTTP、损坏记录与死信报告、本地 ACK 失败保留记录、参数与
配置检查和本地 I/O 失败清理，以及实际 CLI 子进程的 SIGINT / SIGTERM 退出。
HTTP 场景使用本机测试服务，不调用模型，也不依赖 #1142 checkout。

最终 Windows Node 22 全套结果：6 个文件，59 项通过，2 项跳过。Windows 不提供与
POSIX 相同的子进程信号语义，因此跳过两个真实信号用例；在途取消和信号监听器清理
仍由其他用例覆盖。Linux Docker Node 22：6 个文件，61 项全部通过，包含两个实际
子进程信号用例。两个平台的 outbox 独立类型检查均通过。

过程中旧 worker 停止测试的固定 50 毫秒取消，在 Windows 并行负载下可能早于发送
开始，导致断言失败。已改为等待发送真正开始后取消，保持原有断言；最终全套通过。

证据文件为同一临时验证目录中的 `windows-node22-run-tests.log` 和
`docker-node22-run-tests.log`。本次只补 CLI、相关测试和文档，未修改 worker 投递
策略、Pi 插件或现有代理捕获路径；没有完成 Pi 自动 enqueue 接线。

## 实际 run 命令强杀与重启验证（2026-10-08）

新增 `__tests__/pi-outbox-cli-crash.test.ts`，在 Windows 和 Linux 上直接启动实际
`pi-outbox-cli.ts run` 子进程。只将扫描间隔设为 100 毫秒，租约、时钟、发送器
和重试策略均使用正常实现。

验证顺序与断言：

1. 排队一条记录，HTTP 接收端收到完整请求后暂不返回回执。
2. 强杀发送进程，确认没有执行正常停止收尾，磁盘保留原记录及第一次领取的租约。
3. 立刻用同一目录启动第二个真实命令进程；旧租约尚未到期时，不提前重发。
4. 等待默认 30 秒租约按实际墙钟自然到期；检查第二次请求与第一次的 JSON 字节、
   idempotency key 和身份头一致，持久化尝试次数增加至 2。
5. 返回成功回执，确认实际 CLI 报告已投递且队列为空。
6. 再次强杀并重新打开队列，确认已 ACK 的记录没有恢复。

未推进测试时钟、编辑租约文件名或使用专用发送进程替代 CLI。HTTP 接收端是本地测试
夹具，此用例验证命令端恢复，不声称验证真实数据库去重；后者由已有 #1142 契约测试
覆盖。本次没有改动生产代码、Pi 插件或捕获接线。

Node 22.23.2 下最终全套结果：Windows 7 个文件，60 项通过、2 项 POSIX 信号测试
跳过；新增强杀测试没有跳过。Linux Docker 7 个文件、62 项全部通过。两个平台的
outbox 独立类型检查通过。新增用例在 Windows 单独运行约 31.5 秒，全套运行约
31.8 秒；Linux 全套运行约 34.4 秒。

本次证据保存在 `C:/Users/小米/.codex/tmp/pi-outbox-cli-crash-20261008`：
`windows-crash-targeted.log`、`windows-tests.log` 和 `linux-tests.log`。
此前便携 Node 所在临时目录已不存在，本次重新下载同一官方版本并核对相同 SHA-256，
没有修改系统默认 Node。测试子进程、HTTP 接收端、临时队列和测试容器均由测试清理。
