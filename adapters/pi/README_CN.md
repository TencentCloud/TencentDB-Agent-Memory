# Pi 的 TencentDB Agent Memory 适配器

这是一个本地 Pi 扩展，让 **之后的** Pi 对话可以通过 TencentDB Agent Memory 获得可持续、可隔离的记忆。它不会导入、修改或上传你已有的 Claude Code、Codex 或 Pi 聊天记录。

## 项目介绍

**一句话：** 把 TencentDB Agent Memory 接进 Pi，让 Pi 拥有跨会话的持久记忆和可沉淀的技能——告诉它的东西不随会话消失，学会的本事能自己长出来。

**为什么需要它。** Pi 默认不保留会话之间的记忆。每次新开会话，它都不记得你是谁、上次做过什么、之前解决过什么问题。这对日常使用是真实的痛点：同样的坑反复踩、同样的上下文反复讲。这个项目给 Pi 装上一个"长效大脑"。

**它解决什么问题。**

- **跨会话记忆**：你在项目里告诉 Pi 的偏好和结论，下次会话它能想起来。
- **记忆自动进化**：不是简单存对话——服务端会从采集的对话里异步提炼出原子记忆（L1）、场景笔记（L2）和长期画像（L3）。
- **技能学习**：工具密集的回合会被服务端审查模型提炼成可复用的 `SKILL.md`，既能在相关问题时自动注入上下文，也能同步成 Pi 的原生技能。
- **分支隔离**：Pi 的 `/tree` 分支各自持有独立的记忆身份，互不串台。

**架构**：适配器是 Pi 的一个本地扩展，通过官方 SDK 与 MemoryCore 通信——不手写 HTTP、不走私有协议：

```text
Pi 会话 ── 适配器（本地扩展）── 官方 SDK ── MemoryCore（记忆 + 技能引擎）
   │
   ├─ before_agent_start → 召回 L0-L3 + 相关技能，注入为「不可信」上下文
   ├─ agent_settled      → 采集回合（L0 走 durable outbox；技能 at-most-once）
   └─ 命令 / 工具        → setup / status / sync-skills / 4 个只读搜索工具
```

**设计价值观（为什么可以放心用）。**

- **fail-open**：记忆服务挂了、超时了、配置错了，Pi 照常回答——只少记忆，绝不多一步阻塞。
- **不可信边界**：召回的记忆永远标记 `untrusted`，注入内容不会被当成指令执行。
- **可靠性**：L0 走跨进程文件 outbox（at-least-once、离线补投、死信隔离）；技能写入是 at-most-once，绝不重发污染服务端缓冲。
- **官方 SDK，不造轮子**：认证、隔离、TLS 全部走官方客户端；适配器只做"把 Pi 的回合翻译成 Memory 能懂的协议"。
- **安全默认**：写入前脱敏密钥、项目配置碰不到凭证、远程强制 HTTPS。

**快速开始。** 详见下文。最简单路径：启动 MemoryCore → 在 Pi 里运行 `/tdai-memory-setup` 走完向导 → 开始使用。想体验技能学习，加一行 `"skills": { "enabled": true }`，做完一个工具密集的任务后运行 `/tdai-memory-sync-skills`。

## 常见疑问（为什么看不到东西？）

**"装了之后好像没反应？"**
适配器是"攒记忆"的，不是即时反馈。前几轮会话看不到召回是正常的——记忆要等服务器从你的对话里提炼出来。

**"多久能看到记忆？"**
结束几个会话后（每轮一条 user + assistant），服务器会异步提炼 L1/L2/L3。新开会话问相关的问题，适配器会把相关记忆注入上下文，状态显示 `memory: recalled`。

**"skills 是干嘛的？要自己装吗？"**
**不用装。** 这里有两个"skills"概念：
- **Pi 原生 skills**：手写或下载的技能包，放在 `<agentDir>/skills/`——那是 Pi 自己的系统，**得自己装**。
- **Memory 服务端"学出来"的 skills**：审查模型从你干活的对话里**自动**提炼出 `SKILL.md`——不用你装、不用你写。
适配器把两者接起来：服务端自动学 → 你想把学到的技能变成 Pi 原生 `/skills` 里看得见、可编辑的文件，就跑一次 `/tdai-memory-sync-skills`。

**"技能为什么一直不出来？"**
服务端按"每个会话累计 40KB 或 10 次工具调用"才归档提炼。日常短对话攒得慢；**工具密集的一轮任务**最快见效。

**"status 里的数字是什么意思？"**
- `Memory: no conversations yet` → 还没采集到对话，先和 Pi 聊几轮、结束会话。
- `Skills: pending N · uncertain N · dead N` → pending = 待投递；uncertain = 网络模糊失败不自动重试（下轮继续，通常不用管）；dead = 确定失败已隔离（可看要不要清理）。

**"记忆服务挂了会不会影响 Pi？"**
不会。fail-open——Pi 照常回答，只是这一轮没有记忆可注入。

## 第一版能做什么

- Pi 开始回答前：自动召回有界的 L0 对话证据、L1 原子记忆、相关 L2 场景正文和 L3 核心画像，并以“**不可信参考资料**”的形式放进上下文。
- Pi 对话稳定结束后：先把最终成功的一轮“用户问题 + 助手回答”脱敏写入本地待投递队列，再异步写入该 Pi 会话的隔离空间；Memory 暂时离线时留待之后重试；连续三次失败后，记录会保留为本地 `.dead` 文件，不再阻塞后续采集。
- Pi `/tree` 分支获得独立的 Memory session 身份；返回旧分支会恢复其身份，而 `/fork` 因 Pi 分配的新 session id 天然隔离。
- 写入前会遮蔽常见 `sk-*`、Bearer Token、私钥文本；状态命令不会输出密钥。
- Memory 配置、网络或服务故障时会降级，不会阻止 Pi 正常回答。

L1–L3 由 MemoryCore 根据已采集的对话异步生成；适配器只读取它们，不伪造、编辑或删除。除 setup 向导可选创建私有 Agent 外，不会自动创建 Team/Agent，也不迁移历史聊天。投递语义是 at-least-once：如果服务端已经接受请求但响应丢失，之后重试可能产生重复。

## 前置条件

- Node.js `>= 22.19.0`
- 已用 Pi `0.84.1` 验证开发流程。适配器依赖 Pi 的扩展 API 契约（hooks、`registerTool`/`registerCommand`、`ctx.ui`、消息格式），`peerDependencies` 声明兼容 `>=0.84.1 <0.85`；升级 Pi 前建议先跑 `npm run verify:pi-load` 与端到端检查。
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

`verify:pi-load` 会用锁定版本的 Pi 开发依赖启动离线 RPC，并断言 `/tdai-memory-setup` 和 `/tdai-memory-status` 都已注册；它不需要 Memory 密钥，也不会调用模型。

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

> 服务端冷启动会自动创建团队可见的 `default-agent-<用户名>`。向导复用**非私有** Agent 时会先确认——个人记忆写在团队可见的 Agent 里会与团队共享。默认创建**私有** `Pi` Agent 更安全，个人记忆只属于你。

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

远程服务必须使用操作系统信任证书的 HTTPS。也可以用 `TDAI_MEMORY_USER_KEY` 提供密钥；如果没有单独设置 `TDAI_MEMORY_GATEWAY_API_KEY`，会安全地复用 User Key 作为 Gateway Bearer。其他覆盖变量：`TDAI_MEMORY_ENDPOINT`、`TDAI_MEMORY_SERVICE_ID`、`TDAI_MEMORY_TEAM_ID`、`TDAI_MEMORY_AGENT_ID`、`TDAI_MEMORY_USER_ID`、`TDAI_MEMORY_TIMEOUT_MS`、`TDAI_MEMORY_USER_KEY_FILE`、`TDAI_MEMORY_GATEWAY_API_KEY_FILE`。`TDAI_MEMORY_REJECT_UNAUTHORIZED` 会被读取，但只支持 `true`；适配器故意不支持关闭 TLS 证书校验。

## 验证效果

启动 Pi 后运行：

```text
/tdai-memory-setup
/tdai-memory-status
```

先执行一次 setup。`/tdai-memory-status` 会检查配置、鉴权、元数据可见性和 L0 读取能力，只显示掩码后的信息，绝不会回显密钥。一次完整回答后看到 `memory: captured`，表示该轮已被服务接受；在同一个 Agent 上进行下一次相关提问，就可能看到检索到的记忆。

可在配置的 `recall` 对象中调整召回上限。默认全局 deadline 为 3,000 ms，L0=4、L1=6、L2=2，四层合计最多 12,000 个字符；到时后 Pi 直接使用已完成的层继续回答，超时或失败的层不会阻止 Pi 继续运行。

`captureTools` 默认是 `false`。只有明确设置为 `true` 才会把成功工具结果的文本证据一并采集；失败工具输出、图片/二进制内容和过大的输出会被排除或截断，常见凭据会在进入本地待投递队列前脱敏。

### Skills 学习闭环

Skills 默认关闭（`skills.enabled` 默认 `false`）。开启后，适配器会把每个落定的回合按五角色会话格式采集，投递到 Memory 网关的 `/v3/skill/conversation/add`，由服务端异步抽取把可复用的可执行能力提炼成 SKILL.md。召回时，适配器按 `skills.routingMode` 搜索这些技能，并把最匹配的结果作为第五层不受信的 `[Skill]` 注入召回记忆块。

全局配置中可选的 `skills` 对象：

```json
{
  "skills": {
    "enabled": true,
    "capture": true,
    "runtimeTools": true,
    "routingMode": "bm25",
    "allowTeamSearch": false,
    "includeFailedTools": false,
    "maxMessageBytes": 32768,
    "maxToolItems": 16,
    "flushTimeoutMs": 1500
  }
}
```

- `enabled` — 总开关；`tdai_skill_search` / `tdai_skill_read` 工具与采集都受它控制。
- `capture` — 是否把落定回合投递用于技能抽取。置 `false` 时召回仍可用，但不再学习新技能。
- `runtimeTools` — 是否暴露会话内 `tdai_skill_search` / `tdai_skill_read` 工具。它们与记忆工具共享每回合 3 次调用上限。
- `routingMode` — `bm25`（默认）| `embedding` | `hybrid`；须与网关技能路由配置一致。
- `allowTeamSearch` — 技能搜索范围扩展到整个 Team 而非当前 Agent。
- `includeFailedTools` — 是否把失败的工具调用保留在采集会话里（默认排除）。
- `maxMessageBytes` — 单条消息字节上限（1 KiB–1 MiB），默认 32 KiB。
- `maxToolItems` — 每回合最多采集的 tool_call/tool_result 对数（0–100），默认 16。
- `flushTimeoutMs` — 单次 conversation/add 投递的截止时间（100 ms–30 s），默认 1500 ms。

投递语义是 at-most-once：每个落定回合先写入本地待投递文件，恰好发送一次后才删除。网关返回确定性 4xx 时记录进入死信路径；超时或 5xx 时保留并标记为 `uncertain`，**绝不自动重试**——因为重发会污染服务端累计会话缓冲。任何环节都不需要人工确认；由服务端 review agent 判断什么值得沉淀为技能。

### 把技能同步成 Pi 原生技能

服务端学到的技能默认只活在服务端，靠召回注入间接使用。执行：

```text
/tdai-memory-sync-skills
```

命令会拉取服务端技能列表，让你挑选（或全选）并确认，然后逐项把远程 `SKILL.md`（含可选资源）安全下载到 `<agentDir>/skills/<name>/`，最后 reload Pi。下载经过完整性校验（frontmatter 合法、路径无逃逸、大小有界、不设执行位），并采用临时目录 + 原子替换，任一步失败都回滚保留旧版本。同步后的技能进入 Pi 原生发现链路：出现在 `/skills`、由 Pi 自身加载，与你手写的技能同等对待。**同名的手写技能（目录里没有 `tdai-remote.json` 标记）不会被覆盖**；只有以前同步过的技能才会被新版本替换。

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

### 受管服务端与真实 Pi 生命周期 E2E

同一套一次性 MemoryCore 容器还驱动两个受管检查：

- `npm run e2e:setup` 用脚本化的 `ctx.ui` 应答 + 真实 SDK 客户端把 `/tdai-memory-setup` 向导对着真实服务跑完，覆盖四个场景：创建私有 Agent / 复用已有 Agent / 假密钥被真实身份校验拒绝 / 取消干净；断言写入的全局配置经 `loadConfig` 往返一致且**不含密钥值**（只含路径）。
- `npm run e2e:lifecycle` 用锁定的真实 Pi 0.84.1 RPC 模式验证三条可靠性承诺：(1) 重启不会重复采集已安顿的回合——预先在文件 outbox 里放一条未投递采集，Pi 启动时恰好投递一次，再次重启不再投递，且观察到 Pi 加载会话时从不重发 `agent_settled`；(2) RPC `fork` 命令产出新会话 id、在 header 记录源文件为 `parentSession`、保留 `tdai-memory/branch@1` 标记，使分叉落到各自隔离的 Memory 会话；(3) 服务中断不丢记忆也不重复——在一条采集仍排队时停掉 MemoryCore，Pi 仍能正常启动（fail-open）且记录保持 pending，服务恢复后新 Pi 恰好投递一次，再次重启不再投递。

```powershell
cd adapters\pi
npm run e2e:setup -- --env-file ../../deploy/global-images/.env
npm run e2e:lifecycle -- --env-file ../../deploy/global-images/.env
```

### 真实 Skills 闭环 E2E

- `npm run e2e:skill` 用同一套一次性 MemoryCore 容器验证完整 Skill 学习闭环：(1) 向 `/v3/skill/conversation/add` 提交一段真实的"排查 Node CI 构建 OOM"对话（含 40 KB+ 构建日志，跨过服务端字节归档阈值），断言单次追加即返回 `archived`；(2) 等真实 LLM 审查模型从对话中抽取出一个可复用技能，断言它能被 `/v3/skill/list` 列出；(3) 用真实 Pi 0.84.1 加载适配器并开启 `skills.enabled`，断言该技能以第五层 `[Skill]` 形式进入 `before_agent_start` 的不可信召回 system prompt。与 L0–L3 相同：Pi 本身不发回答模型请求，模型消耗只来自 MemoryCore 抽取。

```powershell
cd adapters\pi
npm run e2e:skill -- --managed-core --env-file ../../deploy/global-images/.env
```

## 卸载

卸载适配器不会删除服务端记忆——数据仍保存在你配置的 Memory 服务里。需要彻底移除时按顺序：

1. 停止加载适配器：从 Pi 启动参数中去掉 `-e <适配器目录>`，或从 Pi 的扩展配置中移除该扩展，然后重启 Pi。
2. 删除全局配置 `~/.pi/agent/tdai-memory.json`（Windows：`%USERPROFILE%\.pi\agent\tdai-memory.json`；设置了 `PI_CODING_AGENT_DIR` 时以它为准）。若显式放行过项目配置（`allowProjectConfig`），也删除项目目录下的 `.pi/tdai-memory.json`。
3. 检查本地待投递队列 `<agentDir>/tdai-memory-outbox/`：下次启动适配器会把未投递的记录补投给服务端；`*.json.dead` 文件是多次重试仍失败、已隔离的记录。确认不再需要后即可删除整个目录。
4. User Key 是你自行管理的文件——适配器从不写入密钥。要真正作废该 Key 或清理服务端记忆，请登录 Memory 服务操作。

## 安全提醒

- User Key 等同密码，不能贴到 issue、聊天记录、提交的 JSON 或截图中。
- Team、Agent、User 一起决定数据范围；实验请使用单独 Agent。
- TLS 证书校验不能关闭。本地开发请使用 loopback HTTP；HTTPS 请安装受信任证书。
