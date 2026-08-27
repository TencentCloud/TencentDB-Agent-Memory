# Changelog

本文件记录 **TencentDB Agent Memory** 的显著变更，格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/)。

覆盖仓库全部开源模块：`MemoryCore` / `MemoryPanel` / `MemoryKnowledge` /
`MemoryProxy` / SDK。

---

## [2.0.1] — 2026-08-25

### 🚀 支持更多 Agent 客户端

现在无论你用哪款 coding agent，都能直接挂上团队记忆：

- 新增 **OpenCode** 客户端接入
- 新增 **DeepSeek Harness (dsh)** 接入 —— DeepSeek 官方 agent harness 的
  Web UI 会话可直接接入 Proxy，自动获得团队记忆 / skill / 知识注入
- 新增 **Codex CLI** 接入
- 新增 **WorkBuddy** 客户端接入，开箱即用
- 多款客户端的首次引导与重置体验保持一致，切换更顺畅

### 🤖 会话内直接下指令

不用切到面板，在对话里就能完成常用操作：

- 会话中途一键重置绑定（换团队 / 换 Agent / 换任务）
- 对话内直接创建 / 更新任务
- 指令响应更快，减少等待

### 🧠 冷启动开箱即用

- 创建团队或用户即自动生成默认 Agent，无需手工配置
- 管理员可自定义默认 Agent 模板，新用户冷启动自动套用
- 支持从 IDE 里已有的 Agent 一键导入资产，快速起步
- 接入后默认绑定任务，即开即用

### 🔄 会话绑定更稳定

- 会话绑定持久化保存，重启不丢失
- 切换 Agent 后记忆与技能正确跟随切换，不再串场
- 修复部分客户端历史回放被误判的问题

### 🧰 技能（Skill）体验升级

- 会话里新建的技能立即可被检索到，不再有"搜索盲区"
- 恢复技能 ID 的展示与一键复制
- 技能支持在线编辑
- 新增接入向导技能：跟着引导一步步配置，或一条命令自动完成 Proxy 接入

### 🎛️ Memory Hub 面板

- 全新登录页，加入点阵波纹动效
- 团队编辑 / 删除入口整合到团队切换器，操作更顺手、修复切换异常
- 管理员创建账号时可自定义 User_Key
- 新增对话记忆搜索：跨会话的语义与关键字检索，按权限精确控制可见范围；
  支持对单层记忆直接覆盖修改
- 资产 ID 直接展示并可复制；列表完整加载，修复分页截断显示不全的问题

### ⚙️ 一键部署增强

- 启动脚本支持交互式配置，自动预检 LLM 通路与端口占用，避免部署踩坑
- 客户端接入地址一键复制，单机部署下自动解析为宿主机地址，外部客户端可直接连接

### ⚡ 性能优化

- 知识库列表加载提速，常用路径更快响应
- Wiki 页面并发构建，单页失败自动重试，大批量文档导入时间大幅缩短

### 📚 文档

- 按客户端拆分独立接入文档，各 agent 各有一份清晰的接入指南
- 新增面板与 API 使用文档
- 补充英文面板截图与 README 更新

### 🐛 修复

- 修复多 Agent 场景下记忆检索为空的问题
- 修复资产解绑不生效、资产较多时记忆 tab 丢失的问题
- 修复导入历史会话时间错乱，恢复原始时间线
- 修复编辑场景时部分内容被重复展开的问题
- 修复 macOS 下部署脚本的兼容性问题
- 修复依赖缺失导致的安装报错
- 修复部分客户端首次引导表单在老版本上的兼容性问题
- 新增清空对话记忆功能，支持批量删除

---

## [2.0.1-beta.1] — 2026-08-13

### 🧠 冷启动开箱即用 · 默认 Agent + 预置 Skill

- 创建团队/用户即自动生成默认 Agent，无需手工配置
- 客户端接入地址一键复制，支持指向 Memory Proxy
- 单机部署下接入地址自动解析为宿主机地址，外部客户端可直接连接

### ⚡ Wiki 生成加速

- 优化 Wiki 生成，页面并发构建，大幅缩短大批量文档导入时间
- 单页失败自动重试，不再拖停整个批次
- 生成进度与单页状态实时可见

### 🧰 Skill 生态

- 新增 Skill 导出功能
- 优化 Skill 检索，私有 Skill 可被检索到，结果更精准
- 优化 Skill 提取能力，捕获范围更广

### 🔀 Memory Proxy · 新增客户端接入

- 新增 Codex CLI 接入
- 新增 WorkBuddy 客户端接入
- 新增 DeepSeek Harness (dsh) 接入 —— DeepSeek 官方 agent harness 的 Web UI 会话
  可直接接入 Proxy,拿到团队记忆 / skill / knowledge 注入;支持 aux 请求短路
  (compaction / title-gen) 与 CLI headless bypass
- 优化 code-graph 资源与工作区的关联

### 🎛️ Memory Hub 面板

- 重构首次使用引导流程，新增 Agent 绑定步骤
- 优化面板交互、加载骨架屏与过渡动效
- 优化 Task 页用户展示名解析
- 优化资产页面布局与归属/共享规则说明
- 修复资产较多时记忆 tab 丢失的问题

### 🐛 修复

- 修复多 Agent 场景下记忆检索为空的问题
- 修复资产解绑不生效的问题
- 导入的历史会话保留原始时间，时间线不再错乱
- 修复某些场景下记忆丢失的问题
- 新增清空对话记忆功能，支持批量删除

---

## [2.0.0] — 2026-08-03

> **产品定位**：让 Agent 的经验、文档、代码沉淀成可复用资产，让下一位 Agent
> 直接读档。详见 [README_CN.md](./README_CN.md)。

### 🧠 四种记忆资产 · 首次完整开源

四类资产从"对话/工作痕迹"里自动沉淀出来：

- **Chat Memory** — 从对话中逐层提取 L0 原始记录 → L1 事实 → L2 场景 → L3
  长期认知；跨会话保留偏好、决策、交互历史。
- **Skill** — 从跑通的任务里提炼可复用 SOP，附版本 / 资源文件 / 触发边界 /
  执行步骤 / 验证规则。新增 Skill 强制归档功能。
- **Wiki** — 把文档变成结构化页面 + 链接图谱（灵感来自 Karpathy 的 LLM 知识库
  实践）。
- **CodeGraph** — 索引仓库的符号 / 文件 / 调用关系 / 影响路径，Agent 改代码
  前先做 impact analysis。新增定时自动同步代码库功能。

### 🎛️ Memory Hub · 面向团队的操作台

管控面板（`agentmemory/memory-hub` 镜像，含 Panel + Knowledge Service）：

- 建 Team / Agent，把资产按 Owner / 版本 / 状态 / 可见性统一管理
- 三级可见性：`private` / `team` / `restricted`（User / Role / Agent ACL），
  外加 `agent` 定向装配
- Agent Loadout：给不同 Agent 绑定不同资产、调整优先级和使用方式
- Wiki + CodeGraph 工坊内置在 Hub，导入代码库/文档就能自动构建
- 管理员（System Admin）现在也可使用资产管理功能
- 面板全面支持中英文切换；统一页面设计风格，优化列表交互和分页体验

### 🔀 Memory Proxy · Agent 挂上记忆的通道

`agentmemory/memory-proxy` 让 Claude Code 等 coding agent 直接用上团队记忆：

- **Anthropic / OpenAI 双协议**：`/claude-code/<spaceId>/v1/messages` 和
  `/v1/chat/completions` 都接
- **首轮引导**：sessionInit 通过 `AskUserQuestion` 让用户选 team / agent /
  task，proxy 记住绑定
- **每轮注入**：把该 agent 的 L2/L3 记忆、matched skill、wiki/code-graph
  拼进 system prompt，转发上游 LLM
- **鉴权**：`x-tdai-user-key` → 内核 `/v3/meta/auth/verify` 换 `user_id`，
  按用户维度控制资产可见性
- Cost Guard 支持为不同 Agent 配置不同模型以降低成本

### 🚀 一条命令拉起完整三件套

三个镜像多架构（`linux/amd64` + `linux/arm64`）已发布到
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory)，公开可拉、
无需登录：

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # 填入两组 LLM 参数
./start-all.sh                          # 一键起
```

`start-all.sh` 首次启动会自动 `init-admin`、生成 admin `sk-mem-...` 并落盘
`.admin-key`；自检 `/v3/meta/auth/verify` 后打印可复制的 `claude` 启动命令。
`stop-all.sh --purge` 彻底清 volume + admin key，方便重置。

详见 [INSTALL_CN.md](./INSTALL_CN.md) / [INSTALL.md](./INSTALL.md)。

### 🧰 官方 SDK

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 严格 isolation：三项必填
  });
  ```

  顶级 export 就是 v3 严格 isolation 版本；老代码走 `.../v2/v3` 子路径也
  能继续用（子路径保留为向后兼容别名）。

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # 默认（v2 兼容）
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```

### 📖 文档

- 新增 CodeBuddy / Hermes / OpenClaw 接入指南
- 更新安装指南中的角色权限说明

---

## [2.0.0-beta.1] — 2026-07-21

首次公开发布。SemVer 从 `2.0.0-beta.1` 起步（npm 包名迁移到 `-v2` 后缀：
`@tencentdb-agent-memory/memory-tencentdb-v2`、`memory-sdk-ts-v2`）。
Docker 镜像 tag 独立于 npm 版本，本次镜像发的是 `:1.0.0-beta.1`。

> **产品定位**：让 Agent 的经验、文档、代码沉淀成可复用资产，让下一位 Agent
> 直接读档。详见 [README_CN.md](./README_CN.md)。

### 🧠 四种记忆资产 · 首次完整开源

四类资产从"对话/工作痕迹"里自动沉淀出来：

- **Chat Memory** — 从对话中逐层提取 L0 原始记录 → L1 事实 → L2 场景 → L3
  长期认知；跨会话保留偏好、决策、交互历史。
- **Skill** — 从跑通的任务里提炼可复用 SOP，附版本 / 资源文件 / 触发边界 /
  执行步骤 / 验证规则。
- **Wiki** — 把文档变成结构化页面 + 链接图谱（灵感来自 Karpathy 的 LLM 知识库
  实践）。
- **CodeGraph** — 索引仓库的符号 / 文件 / 调用关系 / 影响路径，Agent 改代码
  前先做 impact analysis。

### 🎛️ Memory Hub · 面向团队的操作台

管控面板（`agentmemory/memory-hub` 镜像，含 Panel + Knowledge Service）：

- 建 Team / Agent，把资产按 Owner / 版本 / 状态 / 可见性统一管理
- 三级可见性：`private` / `team` / `restricted`（User / Role / Agent ACL），
  外加 `agent` 定向装配
- Agent Loadout：给不同 Agent 绑定不同资产、调整优先级和使用方式
- Wiki + CodeGraph 工坊内置在 Hub，导入代码库/文档就能自动构建

### 🔀 Memory Proxy · Agent 挂上记忆的通道

`agentmemory/memory-proxy` 让 Claude Code 等 coding agent 直接用上团队记忆：

- **Anthropic / OpenAI 双协议**：`/claude-code/<spaceId>/v1/messages` 和
  `/v1/chat/completions` 都接
- **首轮引导**：sessionInit 通过 `AskUserQuestion` 让用户选 team / agent /
  task，proxy 记住绑定
- **每轮注入**：把该 agent 的 L2/L3 记忆、matched skill、wiki/code-graph
  拼进 system prompt，转发上游 LLM
- **鉴权**：`x-tdai-user-key` → 内核 `/v3/meta/auth/verify` 换 `user_id`，
  按用户维度控制资产可见性

### 🚀 一条命令拉起完整三件套

三个镜像多架构（`linux/amd64` + `linux/arm64`）已发布到
[Docker Hub `agentmemory`](https://hub.docker.com/u/agentmemory)，公开可拉、
无需登录：

```bash
git clone https://github.com/Tencent/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env && $EDITOR .env    # 填入两组 LLM 参数
./start-all.sh                          # 一键起
```

`start-all.sh` 首次启动会自动 `init-admin`、生成 admin `sk-mem-...` 并落盘
`.admin-key`；自检 `/v3/meta/auth/verify` 后打印可复制的 `claude` 启动命令。
`stop-all.sh --purge` 彻底清 volume + admin key，方便重置。

详见 [INSTALL_CN.md](./INSTALL_CN.md) / [INSTALL.md](./INSTALL.md)。

### 🧰 官方 SDK

- **TypeScript** — `@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 严格 isolation：三项必填
  });
  ```

  顶级 export 就是 v3 严格 isolation 版本；老代码走 `.../v2/v3` 子路径也
  能继续用（子路径保留为向后兼容别名）。

- **Python** — `pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory import MemoryClient                     # 默认（v2 兼容）
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```
