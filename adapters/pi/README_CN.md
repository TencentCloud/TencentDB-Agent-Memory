# Pi 的 TencentDB Agent Memory 适配器

这是一个本地 Pi 扩展，让 **之后的** Pi 对话可以通过 TencentDB Agent Memory 获得可持续、可隔离的记忆。它不会导入、修改或上传你已有的 Claude Code、Codex 或 Pi 聊天记录。

## 第一版能做什么

- Pi 开始回答前：自动召回有界的 L0 对话证据、L1 原子记忆、相关 L2 场景正文和 L3 核心画像，并以“**不可信参考资料**”的形式放进上下文。
- Pi 对话稳定结束后：仅将最终成功的一轮“用户问题 + 助手回答”写入该 Pi 会话的隔离空间。
- 写入前会遮蔽常见 `sk-*`、Bearer Token、私钥文本；状态命令不会输出密钥。
- Memory 配置、网络或服务故障时会降级，不会阻止 Pi 正常回答。

L1–L3 由 MemoryCore 根据已采集的对话异步生成；适配器只读取它们，不伪造、编辑或删除。当前仍不会自动创建 Team/Agent、迁移历史聊天；MemoryCore 离线时也尚未提供跨重启的持久补写。

## 前置条件

- Node.js `>= 22.19.0`
- 已用 Pi `0.84.1` 验证开发流程。
- TencentDB Agent Memory Core 已启动，并且你已有 Team、Agent、User 和 User Key。

## 维护者可复现环境

以下流程从干净克隆开始，不依赖全局安装的 Pi：

```powershell
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory\adapters\pi
node --version # 必须为 v22.19.0 或更高
npm ci
npm run check
npm run verify:pi-load
```

`verify:pi-load` 会用锁定版本的 Pi 开发依赖启动离线 RPC，并断言 `/tdai-memory-status` 已注册；它不需要 Memory 密钥，也不会调用模型。

### 两种加载方式

开发迭代时，以工作区源码临时启动一次 Pi：

```powershell
cd E:\path\to\TencentDB-Agent-Memory
./adapters/pi/node_modules/.bin/pi.cmd -e (Resolve-Path ./adapters/pi)
```

要为一个项目持久安装本地包（Pi 只会写入 `<项目>/.pi/settings.json`），在该项目目录执行：

```powershell
pi install -l E:\path\to\TencentDB-Agent-Memory\adapters\pi --approve
pi list
```

修改扩展源码后，可再次使用第一条命令加载最新源码；或者执行 `pi update E:\path\to\TencentDB-Agent-Memory\adapters\pi --approve` 更新本地包。

目前包仍为开发期 `private`，还不能从 npm / Pi Gallery 安装；发布前需要维护者确认包名与 npm scope 权限。

## 配置

复制 [`tdai-memory.example.json`](./tdai-memory.example.json)，放到以下其一：

- 全局：`~/.pi/agent/tdai-memory.json`（Windows 即 `%USERPROFILE%\.pi\agent\tdai-memory.json`）
- 可信项目：`<项目目录>/.pi/tdai-memory.json`

项目配置覆盖全局配置；环境变量覆盖两者。不要提交密钥文件，也不要把真实 ID、密钥直接写进仓库。

将 User Key 单独放在普通文本文件中，再用绝对路径引用。Windows 最小示例：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "endpoint": "http://127.0.0.1:8420",
  "serviceId": "default",
  "teamId": "team-...",
  "agentId": "agt-...",
  "userId": "usr-...",
  "userKeyFile": "C:\\Users\\you\\.secrets\\tdai-user-key",
  "timeoutMs": 3000,
  "rejectUnauthorized": true
}
```

远程服务必须使用 HTTPS。也可以用 `TDAI_MEMORY_USER_KEY` 提供密钥；如果没有单独设置 `TDAI_MEMORY_GATEWAY_API_KEY`，会安全地复用 User Key 作为 Gateway Bearer。其他覆盖变量：`TDAI_MEMORY_ENDPOINT`、`TDAI_MEMORY_SERVICE_ID`、`TDAI_MEMORY_TEAM_ID`、`TDAI_MEMORY_AGENT_ID`、`TDAI_MEMORY_USER_ID`、`TDAI_MEMORY_TIMEOUT_MS`、`TDAI_MEMORY_REJECT_UNAUTHORIZED`。

## 验证效果

启动 Pi 后运行：

```text
/tdai-memory-status
```

它会检查配置、鉴权、元数据可见性和 L0 读写能力，只显示掩码后的信息，绝不会回显密钥。一次完整回答后看到 `memory: captured`，表示该轮已被服务接受；在同一个 Agent 上进行下一次相关提问，就可能看到检索到的记忆。

可在配置的 `recall` 对象中调整召回上限。默认 L0=4、L1=6、L2=2，四层合计最多 12,000 个字符；任何单层失败都不会阻止其他层或 Pi 继续运行。

### 维护者验收清单

1. `npm run check` 通过。
2. `npm run verify:pi-load` 报告 `/tdai-memory-status` 已注册。
3. 用专用测试 Agent 配置后，`/tdai-memory-status` 显示 `memory: ready`。
4. 用 Pi 发一条短问题，再新开会话问相关问题；第一轮结束应显示 `memory: captured`，第二轮开始前应显示 `memory: recalled`。

第 3–4 步要求 Memory 服务已启动，且可能消耗模型 Token；必须使用可丢弃的测试 Agent，不能使用共享记忆。

## 开发检查

```powershell
cd adapters\pi
npm ci
npm run check
npm run verify:pi-load
npm run pack:check
```

测试不需要联网 Memory 或模型。端到端实验必须使用单独创建的测试 Agent，不能用生产/共享 Agent。

## 安全提醒

- User Key 等同密码，不能贴到 issue、聊天记录、提交的 JSON 或截图中。
- Team、Agent、User 一起决定数据范围；实验请使用单独 Agent。
- `rejectUnauthorized: false` 只适合受控开发证书，远程环境不要关闭证书校验。
