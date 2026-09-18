# TencentDB Agent Memory — gp.nvim 适配器

为 [gp.nvim](https://github.com/Robitx/gp.nvim) 注入持久化团队记忆。本适配器将其 LLM 流量路由至 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入 system prompt
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
gp.nvim ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                         │
                                         ├─ auth        (校验 sk-mem-... user_key)
                                         ├─ sessionInit (Team/Agent/Task 选择器)
                                         └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

gp.nvim 通过 `providers` 表支持任意"OpenAI chat/completions"兼容端点 —— 每个条目声明一个 `endpoint`（**完整的 chat completions URL**）和一个 `secret`（API key、`os.getenv` 调用或输出 key 的命令），Agent 按名称选择 provider（[官方 README](https://github.com/Robitx/gp.nvim#multiple-providers)；内置的 `ollama` 条目 —— `endpoint = "http://localhost:11434/v1/chat/completions"` —— 是本地端点的标准范例）。将 `endpoint` 指向代理的 `/codebuddy/<spaceId>/v1/chat/completions` 路由即可接入 —— **无需任何代码改动**。

**会话绑定**、**记忆注入**与**自动捕获**全部开箱即用。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动 `start-all.sh` 时打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. gp.nvim 已通过插件管理器安装并加载（见 [README](https://github.com/Robitx/gp.nvim# Installation)）。

## 配置步骤

### 1. 导出 API key

```bash
export MEMORY_PROXY_API_KEY=sk-mem-xxxxxxxx   # 你的业务用户 key
```

Neovim 必须继承该变量 —— 从该 shell 启动，或使用 `exec-path-from-shell`。下方配置用 `os.getenv` 读取，key 不会落入 dotfiles。

### 2. 声明 provider 与 Agent

在 gp.nvim 配置中，添加 `endpoint` 为代理完整 chat completions URL 的 provider 条目，以及使用它的 Agent：

```lua
local conf = {
  providers = {
    tencentdb_memory = {
      endpoint = "http://127.0.0.1:8096/codebuddy/default/v1/chat/completions",
      secret = os.getenv("MEMORY_PROXY_API_KEY"),
    },
  },
  agents = {
    {
      name = "TencentDBMemory",
      provider = "tencentdb_memory",
      chat = true,
      command = true,
      model = { model = "claude-sonnet-4-20250514" },
      system_prompt = "You are a general assistant with persistent team memory.",
    },
  },
}
require("gp").setup(conf)
```

若使用其他空间，将 `default` 替换为你的 memory space ID。

**注意**：与自行拼接 `/chat/completions` 的 base-URL 型客户端不同，gp.nvim 的 `endpoint` 是**完整 URL** —— 必须包含 `/v1/chat/completions` 后缀，与内置 `ollama` 条目一致。

### 3. 对齐模型名

Agent 的 `model.model` 值**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`；若代理指向其他上游请相应修改。

### 4. 验证

1. 重启 Neovim（或重新加载配置）使 provider 生效。
2. 用 `TencentDBMemory` Agent 打开 gp.nvim 对话（`:GpChatNew`）并发送首条消息。代理在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 gp 它记得此前会话的哪些内容以确认。

## 配置参考

| 字段 | 取值 | 说明 |
|---|---|---|
| `providers.<name>.endpoint` | `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions` | **完整 URL** —— gp.nvim 原样 POST；`default` 为 memory space ID，按空间修改 |
| `providers.<name>.secret` | `os.getenv("MEMORY_PROXY_API_KEY")` | 环境变量读取；也接受字符串或命令表；以 `Authorization: Bearer` 发送 |
| `agents[].provider` | `"tencentdb_memory"` | 将 Agent 链接到 provider 条目（默认 `"openai"`） |
| `agents[].model.model` | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |
| `agents[].chat` / `command` | `true` | 对话与命令两种工作流均经由该 provider |

## 故障排查

| 症状 | 原因 / 修复 |
|---|---|
| `404` / 连接拒绝 | `endpoint` 必须是完整 URL `http://<host>:8096/codebuddy/<spaceId>/v1/chat/completions` —— 检查是否缺少 `/v1` 或路径笔误，并确认代理运行在 `:8096` |
| "Invalid API Key" / 鉴权失败 | key 必须是 Panel 中的业务用户 key（`sk-mem-...`）—— 而非 `./.admin-key` 的管理员 key；确认 Neovim 启动环境已导出 `MEMORY_PROXY_API_KEY` |
| "Model Not Found" / 上游不匹配 | `model.model` 与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐两者 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若此前会话已绑定 task，绑定会被复用 —— 新建 task 以重新选择 |
| key 解析为 `nil` | `os.getenv` 在 Neovim 内执行 —— GUI Neovim 不继承 shell 导出，除非从该 shell 启动（`exec-path-from-shell` 可解决） |

## 说明

- **纯文档适配器**：provider 位于你自己的 Neovim 配置中，key 不会落入工作区文件；本适配器仅包含文档（与 avante.nvim / codecompanion.nvim 适配器一致）。
- **对话与命令模式均覆盖**：`chat = true` 与 `command = true` 的 Agent 都使用所选 provider，两种工作流均获得记忆注入。
- **数据流向**：仅 prompt/completions 经过代理；记忆数据保留在本地 SQLite（memory-core），除非另行配置。

## 许可证

MIT，与主仓库一致。
