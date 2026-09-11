# TencentDB Agent Memory — codecompanion.nvim 适配器

为 [codecompanion.nvim](https://github.com/olimorris/codecompanion.nvim) 注入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入系统提示词
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
codecompanion.nvim ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                                    │
                                                    ├─ auth        (校验 sk-mem-... user_key)
                                                    ├─ sessionInit (Team/Agent/Task 选择器)
                                                    └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

codecompanion.nvim 内置 `openai_compatible` 适配器，专用于自建及第三方 OpenAI 兼容端点——扩展它并填写 `url`、`api_key`（环境变量名）与 `chat_url` 即可（[官方文档 — Configuring HTTP Adapters](https://codecompanion.olimorris.dev/configuration/adapters_http.html)；内置 llama.cpp 示例采用同样结构）。将其指向代理的 `/codebuddy/<spaceId>` 基础地址即可接入——**无需任何代码改动**。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 持有业务用户的 `user_key`（`sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 已在 Neovim（0.10+）中安装 codecompanion.nvim，并按 [README](https://github.com/olimorris/codecompanion.nvim#installation) 配置 `plenary.nvim` 与 tree-sitter `markdown` / `markdown_inline` 依赖。

## 配置步骤

### 1. 导出 API 密钥

```bash
export MEMORY_PROXY_API_KEY=sk-mem-xxxxxxxx   # 你的业务用户密钥
```

适配器的 `env.api_key` 指定该环境变量的名字，codecompanion 在请求时读取。

### 2. 声明适配器

在 setup 中扩展 `openai_compatible` 并将其选为策略适配器：

```lua
require("codecompanion").setup({
  adapters = {
    http = {
      tencentdb_memory = function()
        return require("codecompanion.adapters").extend("openai_compatible", {
          env = {
            url = "http://127.0.0.1:8096/codebuddy/default",
            api_key = "MEMORY_PROXY_API_KEY",
            chat_url = "/v1/chat/completions",
          },
          schema = {
            model = { default = "claude-sonnet-4-20250514" },
          },
        })
      end,
    },
  },
  strategies = {
    chat = { adapter = "tencentdb_memory" },
    inline = { adapter = "tencentdb_memory" },
    cmd = { adapter = "tencentdb_memory" },
  },
})
```

如使用其他记忆空间，将 `default` 替换为对应 space ID。

### 3. 对齐模型 ID

`schema.model.default` 值**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`，若代理指向其他上游请相应修改。

### 4. 验证

1. 重启 Neovim（或重新加载配置）使适配器生效。
2. 打开对话缓冲区（`:CodeCompanionChat`）发送首条消息。代理会在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 codecompanion 此前会话记得什么即可确认。

## 配置参考

| 字段（adapters.http 条目） | 值 | 说明 |
|---|---|---|
| `env.url` | `http://127.0.0.1:8096/codebuddy/default` | 不含 chat 路径的基础地址；`default` 为记忆空间 ID，按空间替换 |
| `env.api_key` | `MEMORY_PROXY_API_KEY` | 存放 `sk-mem-...` 密钥的环境变量名；以 `Authorization: Bearer` 发送 |
| `env.chat_url` | `/v1/chat/completions` | 拼接在 `env.url` 之后；`openai_compatible` 的默认值，显式写出以示清晰 |
| `schema.model.default` | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| `404` / 连接被拒 | URL 拼写错误或代理未在 `:8096` 运行——实际 chat 端点必须为 `http://<host>:8096/codebuddy/<spaceId>/v1/chat/completions`（`env.url` + `env.chat_url`）；查看 `./start-all.sh` 日志 |
| "Invalid API Key" / 认证错误 | 密钥必须是 Panel 的业务用户密钥（`sk-mem-...`）——不是 `./.admin-key` 管理员密钥；确认环境变量在 Neovim 启动环境中已导出 |
| "Model Not Found" / 上游不匹配 | `schema.model.default` 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开任务可重新选择 |

## 说明

- **仅文档适配器**：适配器配置位于用户自己的 Neovim 配置中，密钥不会落入工作区文件，因此本适配器仅提供文档（与 Kilo Code / Roo Code 适配器一致）。
- **chat / inline / cmd 策略全覆盖**：将各 `strategies` 条目指向该适配器，所有交互均获得记忆注入。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
