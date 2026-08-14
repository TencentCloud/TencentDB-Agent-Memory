# Pi 的 TencentDB Agent Memory 适配器

这是一个本地 Pi 扩展，让 **之后的** Pi 对话可以通过 TencentDB Agent Memory 获得可持续、可隔离的记忆。它不会导入、修改或上传你已有的 Claude Code、Codex 或 Pi 聊天记录。

## 第一版能做什么

- Pi 开始回答前：自动召回有界的 L0 对话证据、L1 原子记忆、相关 L2 场景正文和 L3 核心画像，并以“**不可信参考资料**”的形式放进上下文。
- Pi 对话稳定结束后：先把最终成功的一轮“用户问题 + 助手回答”脱敏写入本地待投递队列，再异步写入该 Pi 会话的隔离空间；Memory 暂时离线时留待之后重试。
- 写入前会遮蔽常见 `sk-*`、Bearer Token、私钥文本；状态命令不会输出密钥。
- Memory 配置、网络或服务故障时会降级，不会阻止 Pi 正常回答。

L1–L3 由 MemoryCore 根据已采集的对话异步生成；适配器只读取它们，不伪造、编辑或删除。当前仍不会自动创建 Team/Agent、迁移历史聊天。投递语义是 at-least-once：如果服务端已经接受请求但响应丢失，之后重试可能产生重复。

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

如需手动配置，可复制 [`tdai-memory.example.json`](./tdai-memory.example.json) 到全局位置：`~/.pi/agent/tdai-memory.json`（Windows 即 `%USERPROFILE%\.pi\agent\tdai-memory.json`）。环境变量覆盖全局配置。不要提交密钥文件，也不要把真实 ID、密钥直接写进仓库。

### 推荐：交互式配置

启动 Pi 后执行：

```text
/tdai-memory-setup
```

向导会询问 endpoint、service ID、已有的 User Key**文件路径**，以及可选的 Gateway Bearer Key 文件路径；随后验证身份，让你选择可访问的 Team 和 Agent（或创建私有 `Pi` Agent），再验证 L0、L1、L2、L3 四层只读权限。全部通过后，它只把非敏感全局配置写入 Pi 并 reload。向导不会要求你在 Pi 界面粘贴密钥，也不会把密钥写入 JSON。本地 Docker 部署可直接选择生成的 `deploy/global-images/.admin-key`。

如果远程 Gateway 需要独立 Bearer Key，请把它放进单独的普通文件，再在向导中提供路径；留空则有意复用 User Key，仅适用于 Gateway 接受该 Key 的部署。

### 手动配置

适配器默认忽略 `<项目目录>/.pi/tdai-memory.json`。只有全局配置显式设置 `"allowProjectConfig": true` 后，可信项目才可以提供配置，并且项目文件**只能**包含 `recall` 对象；它不能覆盖 endpoint、Team/Agent/User 身份、密钥文件路径、TLS 设置或 `captureTools`。

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
  "allowProjectConfig": false,
  "captureTools": false,
  "timeoutMs": 3000,
  "rejectUnauthorized": true
}
```

远程服务必须使用操作系统信任证书的 HTTPS。也可以用 `TDAI_MEMORY_USER_KEY` 提供密钥；如果没有单独设置 `TDAI_MEMORY_GATEWAY_API_KEY`，会安全地复用 User Key 作为 Gateway Bearer。其他覆盖变量：`TDAI_MEMORY_ENDPOINT`、`TDAI_MEMORY_SERVICE_ID`、`TDAI_MEMORY_TEAM_ID`、`TDAI_MEMORY_AGENT_ID`、`TDAI_MEMORY_USER_ID`、`TDAI_MEMORY_TIMEOUT_MS`。适配器故意不支持关闭 TLS 证书校验。

## 验证效果

启动 Pi 后运行：

```text
/tdai-memory-setup
/tdai-memory-status
```

先执行一次 setup。`/tdai-memory-status` 会检查配置、鉴权、元数据可见性和 L0 读取能力，只显示掩码后的信息，绝不会回显密钥。一次完整回答后看到 `memory: captured`，表示该轮已被服务接受；在同一个 Agent 上进行下一次相关提问，就可能看到检索到的记忆。

可在配置的 `recall` 对象中调整召回上限。默认全局 deadline 为 3,000 ms，L0=4、L1=6、L2=2，四层合计最多 12,000 个字符；到时后 Pi 直接使用已完成的层继续回答，超时或失败的层不会阻止 Pi 继续运行。

`captureTools` 默认是 `false`。只有明确设置为 `true` 才会把成功工具结果的文本证据一并采集；失败工具输出、图片/二进制内容和过大的输出会被排除或截断，常见凭据会在进入本地待投递队列前脱敏。

### 维护者验收清单

1. `npm run check` 通过。
2. `npm run verify:pi-load` 报告 `/tdai-memory-setup` 和 `/tdai-memory-status` 已注册。
3. 通过 `/tdai-memory-setup` 配置专用测试 Agent 后，`/tdai-memory-status` 显示 `memory: ready`。
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

### 真实 L0–L3 端到端验证

受管 E2E 会启动一个临时 `agentmemory/memory-core` 容器和临时数据目录，初始化仅用一次的 admin 身份，把真实 L0 对话交给已配置的 LLM 生成 L1/L2/L3，最后用锁定版本的 Pi CLI 加载适配器。一个排在适配器之后的临时观察扩展会确认：四个非空层都进入 Pi 最终的 `before_agent_start` system prompt。它会在 Pi 请求回答模型之前停止，因此模型消耗只来自 MemoryCore 抽取。

先启动 Docker。可传入现有部署 `.env`，也可直接导出 `MEMORY_LLM_BASE_URL`、`MEMORY_LLM_API_KEY` 和 `MEMORY_LLM_MODEL`：

```powershell
cd adapters\pi
npm run e2e:l0-l3 -- --managed-core --env-file ../../deploy/global-images/.env
```

任何一层为空、Pi hook 中缺少任意 L0–L3 分段，或缺少不可信记忆边界，命令都会硬失败。输出只包含脱敏后的临时 ID，不会显示 LLM 或 Memory 密钥；成功和失败都会移除临时容器与数据。该检查会发起真实模型请求，因此会消耗 Token。

## 安全提醒

- User Key 等同密码，不能贴到 issue、聊天记录、提交的 JSON 或截图中。
- Team、Agent、User 一起决定数据范围；实验请使用单独 Agent。
- TLS 证书校验不能关闭。本地开发请使用 loopback HTTP；HTTPS 请安装受信任证书。
