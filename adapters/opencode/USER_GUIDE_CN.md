# TencentDB Agent Memory × OpenCode 使用说明

[English](USER_GUIDE.md) | 简体中文

当前适配器正在提交 PR，尚未发布到 npm。下面两套平台流程都直接从当前工作区安装，不需要 `npx`、`npm pack` 或 `.tgz`。

请按操作系统选择对应章节。Windows 自动安装器使用 `MemoryCore/.env.opencode.local`；macOS/Linux 使用 Gateway 常规的 YAML 与 Shell 配置，不会读取该文件。

## Windows：两步自动安装

### 第一步：创建并填写 `.env`

打开 PowerShell：

```powershell
# 请将 <仓库目录> 替换为 TencentDB-Agent-Memory 的实际下载位置
cd "<仓库目录>\MemoryCore"
notepad .env.opencode.local
```

记事本询问是否创建文件时选择“是”，粘贴下面内容：

```dotenv
# Gateway 本地端口
TDAI_GATEWAY_PORT=18420

# 可选：独立数据目录；留空时使用 Gateway 默认目录
TDAI_GATEWAY_DATA_DIR=

# L0 模式可以留空；开启 L1/L2/L3 或 Skill 时填写
TDAI_LLM_API_KEY=
TDAI_LLM_BASE_URL=https://api.openai.com/v1
TDAI_LLM_MODEL=gpt-4o-mini

# Skill 需要有效的 LLM 配置
TDAI_SKILL_ENABLED=false

# 可选：仅在需要向量或混合语义检索时填写
TDAI_EMBEDDING_API_KEY=
TDAI_EMBEDDING_BASE_URL=
TDAI_EMBEDDING_MODEL=
TDAI_EMBEDDING_DIMENSIONS=1536
```

根据你使用的模型服务修改地址、模型名和 Key，然后保存并关闭记事本。不要把密钥填写到聊天、`opencode.json` 或项目代码中。

完全不填写模型 Key 也可以正常使用基础记忆：

| 功能 | 是否需要模型 Key |
|---|---|
| L0 对话保存与跨会话召回 | 不需要 |
| 主动搜索历史对话 | 不需要 |
| OpenCode 插件安装 | 不需要 |
| L1 原子记忆自动提炼 | 需要 LLM Key |
| L2/L3 场景与用户画像 | 需要 LLM Key |
| Skill 学习与检索 | 需要 LLM Key |
| 向量或混合语义检索 | 需要 Embedding Key |

Embedding 留空时使用 BM25 搜索。密钥只保存在 Gateway 服务端的 `.env.opencode.local`；该文件已被 Git 忽略。

`TDAI_GATEWAY_DATA_DIR` 适合测试或需要完全独立记忆库的用户。可以填写绝对路径；自动安装会生成私有运行配置，不会修改仓库中的 Gateway YAML。

### 第二步：把安装交给 OpenCode

下面的源码自动安装流程目前在 Windows PowerShell 7 上完成了端到端验收。

用 OpenCode 打开 `TencentDB-Agent-Memory` 仓库，把下面整句话发送给模型：

```text
请阅读 adapters/opencode/SELF_INSTALL_CN.md，并严格按顺序执行全部步骤，直到达到其中的完成标准。MemoryCore/.env.opencode.local 已由我填写；只能在不产生输出的本地进程中解析它，不要显示或要求我发送其中的任何密钥。不要只向我解释命令，请直接完成检查、构建、源码安装、Gateway 启动和验收；不得覆盖仓库中的现有修改。
```

模型会自动完成：

- 自动寻找满足 Gateway 要求的 Node.js 22.16+（包括常见的 WorkBuddy/Codex 运行时），并检查仓库状态和 `.env` 安全性
- 仅在能确认进程归属时复用或重启本地 Gateway；未知 Gateway 会明确停止安装并要求换端口，不会被结束
- 安装依赖并运行适配器检查
- 让 OpenCode 直接加载本仓库的构建结果
- 创建不含模型密钥的私密插件配置
- 检查 Gateway、加载器和配置是否一致

安装过程中不要关闭当前 OpenCode 任务。模型明确报告安装结果后，完全退出并重新打开 OpenCode。

## macOS/Linux 源码安装

以下命令直接从当前工作区安装适配器。此流程不要创建 `MemoryCore/.env.opencode.local`：它只供 Windows 安装器使用，下面的命令不会读取该文件。

1. 安装 Node.js 22.16 或更高版本，按照仓库中的 [Gateway 快速启动说明](../../MemoryCore/README_CN.md#快速开始)和[配置说明](../../MemoryCore/README_CN.md#配置)完成配置并启动 Memory Gateway。该流程读取 `TDAI_GATEWAY_CONFIG` 以及同一 Shell 中导出的环境变量；LLM、Embedding、Skill、数据目录和端口都应在这里配置，不要写入 `.env.opencode.local`。继续前先确认实际 endpoint 的 `/health` 可访问。
2. 在另一个终端中构建并测试适配器，然后把当前工作区注册到 OpenCode。快速启动的 Gateway 监听 `8420`；如果配置了其他端口，`--endpoint` 必须使用相同值：

```bash
cd "<仓库目录>/adapters/opencode"
npm ci
npm run check

node ./bin/tdai-opencode.mjs install \
  --scope global \
  --package "file:$PWD" \
  --endpoint http://127.0.0.1:8420

opencode_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
npm install --prefix "$opencode_config_dir" --ignore-scripts
node ./bin/tdai-opencode.mjs doctor --scope global
```

连接远程 Gateway 时，先在当前终端导出 `TDAI_MEMORY_API_KEY`、`TDAI_MEMORY_SERVICE_ID`、`TDAI_MEMORY_TEAM_ID`、`TDAI_MEMORY_AGENT_ID`、`TDAI_MEMORY_USER_ID`，再执行 `install`，并通过 `--endpoint` 传入 HTTPS Gateway 地址。安装器只会把凭据写入权限为 `0600` 的私密配置文件。

`doctor` 的每一项都应显示 `PASS`。随后完全退出并重新打开 OpenCode。由于依赖指向当前工作区，移动仓库或拉取适配器更新后，需要重新执行 `npm run check` 和上面的两条安装命令。

## 重启后验收

发送：

```text
请调用 tdai_memory_status 工具，不要解释名称，不要使用 Shell，只返回工具结果。
```

看到 Gateway 可达、隔离已配置、recall/capture 开启，即表示插件已加载。`原子记忆 0 条` 只表示当前还没有生成 L1 记忆，不是安装失败。

## 平时怎么用

正常聊天即可，完成的对话会自动保存。比如：

```text
请记住：我写 TypeScript 时优先使用严格模式，并避免 any。
```

新建会话后可直接问：

```text
我写 TypeScript 时有什么偏好？
```

需要精确查询时说：

```text
请使用 tdai_memory_search 搜索我之前关于数据库迁移的决定。
```

## 常见提示

- `npm E404`：不要运行尚未发布的 `npx @tencentdb-agent-memory/opencode-adapter`；重新让 OpenCode 执行上面的源码安装任务。
- `timeout 5000ms`：这是单次 Gateway 请求的超时上限，不代表当前已超时；只有请求实际失败时才需要检查 Gateway 日志或提高配置值。
- `Skill module not enabled`：Gateway 与 OpenCode 插件两侧没有同时开启 Skill。把 `.env` 中 `TDAI_SKILL_ENABLED` 改为 `true` 后重新执行自动安装任务。
- `原子记忆 0 条`：L1 尚未提炼出内容；L0 对话保存、历史搜索和跨会话召回仍可使用。
