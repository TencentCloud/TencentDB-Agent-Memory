# 三个 AI 共用记忆：本机使用说明

这套小工具只做一件事：让 Codex、Claude Code 和 ZCode 在新会话里，共用你之后新产生的对话记忆和个人偏好。

它不会接管三个 AI 的模型连接：

- Codex 仍直连 OpenAI。
- Claude Code 仍按你原来的设置直连 MiniMax。
- ZCode 仍使用你当前的模型供应商。
- 三个模型请求都不经过 MemoryProxy。

## 它是怎样工作的

```text
模型线路（完全不变）

Codex ───────────────► OpenAI
Claude Code ─────────► MiniMax
ZCode ───────────────► 当前供应商

记忆线路（新增、独立）

Codex Hook ───┐
Claude Hook ──┼──► D 盘共享适配器 ──► MemoryCore :8420
ZCode Hook ───┘                              │
                                            └──► Memory Hub :8125
```

你提问时，Hook 会读取 L0 原始对话、L1 长期记忆和 L3 用户画像，作为明确标注的历史参考。回答结束后，只保存这一轮的用户问题和最终回答。系统提示、工具过程和中间内容不会被写入。

记忆线路发生故障时，三个 AI 仍会继续回答。写入失败的内容会先进入 D 盘队列，MemoryCore 恢复后再有限重试。

## 开始前确认三件事

1. 正式使用目录必须是 `D:\TencentDB-Agent-Memory`。不要把 Hook 指向 `.worktrees`、下载缓存或其他临时目录。
2. Docker Desktop 已启动，`tdai-memory-core` 正常运行；如果要看管理页面，再启动 `tdai-memory-hub`。
3. Node.js 版本不低于 22.16。运行 `node --version` 可以查看。

Gateway 地址和 Bearer 设置来自：

```text
D:\TencentDB-Agent-Memory\deploy\global-images\.env
MEMORY_CORE_GATEWAY_API_KEY=<Gateway Bearer>
```

`MEMORY_CORE_GATEWAY_API_KEY` 非空时，它才是访问 Gateway 的 Bearer。默认本地部署会把它显式留空，表示关闭 Bearer gate；此时引导程序只会在 `config.local.json` 写入一个固定的非秘密兼容占位值，以满足本地适配器的配置格式，不会把占位值当作认证材料。

同目录的 `.admin-key` 是 MemoryCore 管理员 `user_key`，用于 admin 初始化和用户认证，不是 Gateway Bearer，也不会被引导程序写入 `apiKey`。引导程序不会在屏幕上显示任何 key；如果 `.env` 没有明确声明 `MEMORY_CORE_GATEWAY_API_KEY`，它会停止并提示修正，不会猜测或新造凭据。

## 第一次安装

请在 PowerShell 中依次执行。每一步成功后再执行下一步：

```powershell
Set-Location D:\TencentDB-Agent-Memory\integrations\cross-agent-memory
node src/bootstrap-config.mjs
node src/install-hooks.mjs install
node src/doctor.mjs
```

各步骤的作用：

1. `bootstrap-config` 从现有本地部署读取 Gateway 地址和认证材料，创建或复用固定的正式 Metadata 身份，随后才写入配置。
2. `install-hooks` 只给三个客户端增加两项记忆 Hook，并把原配置备份到 D 盘。
3. `doctor` 一次检查 Node、配置、Gateway、L0/L1/L3、正式身份、Memory Hub L0 以及三个客户端的 Hook。首次还没有写入对话时，`chat-memory` 显示 `WAIT` 属于成功完成诊断，不会阻止后续首次会话验收。

如果 `config.local.json` 已存在，引导程序默认不会覆盖。确实需要重建时使用：

```powershell
node src/bootstrap-config.mjs --force
```

使用 `--force` 前，原文件会先按原始字节备份到 `runtime\backups`。如果 Gateway 没启动，或者固定身份不被当前服务接受，引导程序会停止，不会写入半成品配置，也不要继续安装 Hook。

### 正式 Metadata 身份

这套适配器不使用临时、按客户端拆分的身份。引导程序会在当前登录用户下创建或精确复用以下一组 Metadata 对象，并把服务生成的 ID 写进 `config.local.json`：

| 对象 | 固定名称 | 关系 |
| --- | --- | --- |
| Team | `个人跨 Agent 记忆` | 当前用户拥有 |
| Agent | `共享个人助手` | 属于上述 Team，当前用户拥有 |
| Task | `日常共享对话` | 属于上述 Team，并关联上述 Agent |

不要手工改写 `config.local.json` 中的 `identity`。若必须重建，使用 `bootstrap-config.mjs --force`；它会先备份旧文件，且只有 Gateway 和 Metadata 关系都验证成功后才替换。重复运行 `install-hooks.mjs install` 不会修改这组正式身份，也不会改写 Claude Code 的模型或供应商字段。

## 安装后还要做两件小事

### Codex

在 Codex 中运行 `/hooks`，按界面提示信任本地 Hook。客户端升级后如果 Hook 不执行，也先用 `/hooks` 检查信任状态。

### ZCode

安装后请新开一个 ZCode 会话。已经打开的旧会话可能仍使用安装前的配置。

Claude Code 不需要改模型地址；原有 MiniMax 环境变量、模型和供应商字段都会保留。

### Claude Code 恢复 MiniMax 直连

如果此前曾让 Claude Code 指向 `8096` Proxy，先退出 Claude Code，再从**已核验的、原始 MiniMax 直连设置备份**恢复。该命令只合并 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`，会删除 Proxy 专用的 `ANTHROPIC_CUSTOM_HEADERS`，并在替换前备份当前 `settings.json`：

```powershell
Set-Location D:\TencentDB-Agent-Memory\integrations\cross-agent-memory
node src/restore-claude-minimax.mjs 'D:\可信备份\settings.json'
```

可信来源必须是 `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` 且包含非空 MiniMax Token 的 JSON 文件。不要把 token 粘贴到终端、文档或 issue 中。恢复后新开 Claude Code 会话并运行一次 `node src/doctor.mjs`。

## 日常使用

正常聊天即可，不需要手动调用记忆工具。为了确认共享成功，可以先在一个 Agent 中说一条新的、非敏感偏好，等待该轮结束，再到另一个 Agent 的新会话中询问。

某一轮不想读取也不想保存记忆时，在用户消息中加入任意一个标记：

```text
[不记忆]
/nomemory
```

这一轮会同时跳过召回和写入。

不要把密码、API Key、Token 或私钥交给记忆系统。适配器发现常见凭据特征时会跳过整轮，但这只是第二道保护，不应代替你的谨慎操作。

## 查看记忆

Memory Hub 启动后，在浏览器打开：

[http://localhost:8125/#/memory](http://localhost:8125/#/memory)

这是 **资产管理 → Chat_Memory** 的页面。先切换到 `个人跨 Agent 记忆` Team，再选择 `共享个人助手`；首轮成功写入后，应能看到该正式身份对应的 `chat_memory` 资产及其 L0–L3 内容。若首写后仍不可见，先运行 `node src/doctor.mjs`：`identity` 必须是 PASS，`chat-memory` 才可为 PASS；在尚未首写时显示 WAIT 是预期结果。MVP 不使用 Skill、Wiki 或 CodeGraph。

## 旧数据与 Proxy

本次接入只使用新的正式 Metadata 身份来承接**之后**的新会话：不会迁移、重命名、删除或覆盖旧的对话、旧资产、容器、镜像和卷。旧数据仍按原来的身份和位置保留；如需历史数据迁移，应另行使用项目迁移工具并先备份，不要把它混入 Hook 安装步骤。

仅当以下三项**同时**满足时，才可以在正式部署目录停止 Proxy：

1. Codex、Claude Code、ZCode 的有效模型配置均已不再指向 `http://127.0.0.1:8096`。
2. Claude Code 已在新会话中确认 MiniMax 直连正常。
3. 正式身份已完成首次写入，且 Hub 中对应的 `chat_memory` 资产及其 L0 对话原文均可读取。

任一条件未满足都不要停止 Proxy：

```powershell
Set-Location D:\TencentDB-Agent-Memory\deploy\global-images
docker stop tdai-proxy
```

这只停止容器，**不要**删除容器、镜像或卷。需要回滚到 Proxy 路由时，保留原配置并执行 `docker start tdai-proxy`，再从各客户端对应的操作前备份恢复其 Proxy 设置；恢复后新开客户端并运行 `node src/doctor.mjs`。本说明不代表已经执行过停止或回滚。

## MemoryCore 暂停时会怎样

如果 MemoryCore 暂停或 Docker Desktop没有启动：

- 三个 AI 仍照常连接原模型并回答。
- 本轮没有召回内容时，Hook 会返回空结果。
- 已完成隐私过滤的待写入内容进入 D 盘队列。
- MemoryCore 恢复后，再触发一次回答结束 Hook，队列会在有限时间内自动补交。

本地状态都在正式目录下：

```text
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\logs\status.jsonl
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\capture-queue.jsonl
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\capture-spool\
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\backups\
```

日志只记录状态和错误类别，不应包含完整对话或凭据。队列包含经过过滤的待补交对话，因此不要把 `runtime` 上传到 Git 或发给他人。

## 诊断命令

普通诊断不会写入测试对话：

```powershell
node src/doctor.mjs
```

它逐项显示 PASS、FAIL 或 WAIT：配置、Node、Gateway、L0、L1、L3、正式身份、Hub `chat_memory` 资产、可选写入状态，以及 Codex、Claude Code、ZCode 的 Hook 注册。

只有确实需要验证写入接口时，才运行：

```powershell
node src/doctor.mjs --write
```

该命令会写入一条固定的诊断记录，不包含你的真实对话。

## 卸载

卸载全部三个客户端的记忆 Hook：

```powershell
node src/install-hooks.mjs uninstall
```

只卸载某一个客户端：

```powershell
node src/install-hooks.mjs uninstall --client codex
node src/install-hooks.mjs uninstall --client claude
node src/install-hooks.mjs uninstall --client zcode
```

卸载只删除命令中明确指向本适配器的条目，不会删除原有模型、插件、MCP 或其他 Hook。

## 从备份恢复

每次安装或覆盖配置前，原文件会保存在：

```text
D:\TencentDB-Agent-Memory\integrations\cross-agent-memory\runtime\backups\<时间>\
```

里面按原目录结构保存以下文件中的一个或多个：

```text
.codex\hooks.json
.claude\settings.json
.zcode\cli\config.json
config.local.json
```

恢复时先退出对应客户端，再把最近一次操作前的备份复制回用户目录中的相同位置。不要混用不同时间目录里的文件。恢复后新开客户端，并再次运行 `node src/doctor.mjs`。

通常优先运行精确卸载即可；只有配置文件损坏或确实需要回到安装前原样时，才手动恢复备份。

## 仓库或客户端升级后

不要直接重装。先在正式目录完成升级自检；这些命令只检查代码和本机适配器配置，不会启动、停止或删除 Docker 服务：

```powershell
Set-Location D:\TencentDB-Agent-Memory\integrations\cross-agent-memory
npm test
node --check src\bootstrap-config.mjs
node --check src\install-hooks.mjs
node --check src\doctor.mjs
node --check src\restore-claude-minimax.mjs
node src/doctor.mjs
```

通过后再重复安装一次并复查，确认安装器保持幂等：

```powershell
node src/install-hooks.mjs install
node src/install-hooks.mjs install
node src/doctor.mjs
```

第二次安装不应产生新的 Hook、备份或任何 Claude 模型/供应商字段、`config.local.json` 正式身份的变更。若 `doctor` 的 `identity` 为 FAIL，停止后续安装，先用 `bootstrap-config.mjs --force` 按正式身份章节重建并验证。

## 真实验收（待用户执行）

自动测试和 `doctor` 不能替代真实客户端会话验收。以下步骤需要用户在三个客户端分别新开会话完成；本仓库不声称它们已完成：

1. 在 Codex 新会话写入一条无敏感信息、可辨认的测试偏好，等待本轮结束。
2. 在 Hub 的 [Chat_Memory 页面](http://localhost:8125/#/memory)确认正式身份的 `chat_memory` 资产可读；随后运行 `node src/doctor.mjs`，确认 `identity` 与 `chat-memory` 均为 PASS。
3. 分别新开 Claude Code 和 ZCode 会话，确认能收到该测试偏好；Claude Code 还应确认仍直连 MiniMax，而非 `8096`。
4. 验收后可在任一客户端补充一条无敏感测试信息并跨端检查一次；不要用真实密码、Token、私钥或业务机密作测试内容。

验收失败时，先保留现场并记录 `doctor` 中不含内容的状态；只对失败客户端执行精确卸载或从操作前备份恢复，避免影响另两个客户端。

升级后还应：

1. 各向 Codex、Claude Code、ZCode 的 Hook CLI 做一次离线烟雾检查。
2. 按上面的真实验收步骤完成一次跨端召回。
3. 若仅一个客户端失败，只卸载该客户端的 Hook，另外两个继续使用。
4. Codex 升级后再看 `/hooks` 信任状态；ZCode 升级或重装 Hook 后新开会话。

这套回归把半年内最容易变化的地方集中在 MemoryCore API、Hook 输入输出和三端配置格式。测试和诊断通过后，才重新安装或继续真实验收。

自动化测试为了避免接触真实配置，只在同时设置 `CROSS_AGENT_MEMORY_TEST_MODE=1` 时读取以下临时路径变量：

- `CROSS_AGENT_MEMORY_TEST_ADAPTER_ROOT`
- `CROSS_AGENT_MEMORY_TEST_DEPLOY_DIR`
- `CROSS_AGENT_MEMORY_TEST_USERPROFILE`
- `CROSS_AGENT_MEMORY_TEST_RUNTIME_DIR`

这些变量只用于测试隔离、不承载凭据。日常使用不要设置 `CROSS_AGENT_MEMORY_TEST_MODE`，也不要把上述测试路径变量长期留在用户或系统环境中。

## 本机验证记录

此处只记录日期、客户端版本、容器状态、自动测试数量和五项验收结论。不要记录偏好原文、事实原文或任何 key。首次真实验收完成后再填写。
