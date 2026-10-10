# Pi outbox 验证

验证日期：2026-10-10。启用配置、可靠性边界和运维命令见 [使用说明](./pi-outbox-store.md)。

## 固定版本

| 对象 | 本次验证版本 |
| --- | --- |
| 官方 `feat/server_team` 基线 | `274e549`，已合入工作分支 |
| 实现 | `12eacba`，最终路径调整后 8 项 pipeline 接入测试再次通过 |
| 联调脚本与 CI | `4a8e24c` |
| Node | Windows `22.23.2` |
| Pi 源码 | `ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba`，`1.0.4` |
| #1142 网关 | `a524c609a84e41801d11cbedc77cf9718e9f3691`，独立 checkout |

## 结果

- MemoryProxy 全套测试：7 个文件，69 项通过，2 项 POSIX 信号测试在 Windows 跳过。
- 独立 outbox 类型检查通过；会引入整个 Proxy 的 pipeline 测试由普通测试套件执行。
- 固定 #1142 的实际 conversation handler/SQLite 契约测试全部五个场景通过。
- 实际 Proxy 入口与 Pi CLI/原插件联调通过普通回复和真实 `read` 工具循环；
  相同文字的不同请求使用不同编号，错误用户 key 返回 401。
- 网关不可用期间自动入队；强杀 Proxy 后恢复；网关提交后丢回执再次强杀，重启原样补发。
  最终 6 次逻辑保存、12 条 L0、6 份完成回执、6 次 pipeline 通知，对应 7 次提交后的投递尝试。

完整 Proxy 类型检查剩一处 `src/storage/factory.ts:102` 缺少私有模块
`@context-proxy/cost-guard` 的错误；官方 `274e549` 使用相同依赖也报该错误，
不将完整类型检查记为通过。组件检查排除 pipeline 测试文件；该文件的 8 项测试实际执行通过。

最新服务端接入尚未在 Linux 验证。此前 Linux 投递层检查不能替代本次验证。
新增 `.github/workflows/pi-outbox.yml` 配置 Windows/Linux Node 22 测试和组件类型检查，
以及 Linux 固定 #1142 契约测试；实际 Pi 联调不在 CI 内。
截至本次记录，GitHub 未提供这些检查通过的结果。

## 故障契约

脚本通过本机 HTTP 服务调用真实 #1142 handler 和 SQLite；故障在实际提交后注入。
每个成功场景查询 L0、completed 回执、acknowledged pipeline outbox，并检查通知次数和重放内容。

| 场景 | 请求次数 | 断言 |
| --- | --- | --- |
| 成功回执后、本地 ACK 前强杀，再恢复 | 2 | 原回执，2 条 L0，1 次通知 |
| 相同编号改变内容 | 1 次冲突请求 | 409、进入 DLQ，原记录不变 |
| 网关提交后丢回执，超时重试 | 2 | 原请求与 accepted IDs，2 条 L0，1 次通知 |
| 两个独立消费者竞争一条记录 | 1 | 只有一个消费者成功投递 |
| 两次丢回执耗尽预算，DLQ redrive | 3 | 原编号和内容，复用终态回执，不重复保存 |

竞争场景用进程屏障控制时机。契约夹具缩短超时和重试预算，并在恢复时推进时钟；生产默认值不变。
普通套件中的实际 CLI 强杀测试及 Pi 联调使用真实时钟，等待默认 30 秒租约到期，
检查未到期时不重发、恢复请求原样、最终 ACK；Windows 另测持锁进程死亡后的恢复。

## 复现

使用 Node 22.23.2，在 `MemoryProxy` 安装依赖后执行：

```powershell
npm ci --ignore-scripts
npm test
npm run typecheck:pi-outbox
```

单独 checkout 上述 #1142 提交，安装其 `MemoryCore` 依赖及 `better-sqlite3` 原生模块。
该提交的 MemoryCore 没有 npm lockfile，使用 `npm install`。
Pi 联调还需要上述已安装依赖、已准备模型数据的 Pi 源码 checkout。
以下路径是示例，替换为自己的 checkout：

```powershell
npm run test:pi-outbox:contract -- E:/checkouts/pr1142/MemoryCore
npm run test:pi-outbox:e2e -- E:/checkouts/pr1142/MemoryCore E:/checkouts/pi
```

契约脚本为 `scripts/pi-outbox-contract.ts`，进程夹具为 `pi-outbox-crash-worker.ts`。
端到端脚本为 `scripts/pi-outbox-e2e.ts`，启动真实 `src/index.ts` 和 Pi CLI，
使用仓库现有 Pi 插件及隔离配置，实际执行 read 工具。

## 验证范围

端到端脚本的模型回复和 auth/metadata 是确定性本机夹具，会话初始化使用 `debugForceIdentity`；
Pi、Proxy、#1142 handler 和 SQLite 为实际代码。契约脚本也不启动完整网关的认证和配额链路。
结果不代表生产认证、真实外部模型、其他存储后端或 L1/L2/L3 生成均已验证。
测试使用隔离临时目录和进程，不需要外部模型凭据或费用。

当前实现保留每次模型回复的保存单位；一次工具循环可产生多次保存。
去重覆盖同一持久操作的投递重试，不识别新客户端 HTTP 请求是否属于原操作。
启用时需要兼容 #1142 的网关；成功入队前的崩溃和跨批次原子提交不在保证范围内。
