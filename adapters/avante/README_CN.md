# TencentDB Agent Memory — avante.nvim 适配器

为 [avante.nvim](https://github.com/yetone/avante.nvim) 注入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入系统提示词
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
avante.nvim ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                            │
                                            ├─ auth        (校验 sk-mem-... user_key)
                                            ├─ sessionInit (Team/Agent/Task 选择器)
                                            └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

avante.nvim 通过 `providers` 表支持任意 OpenAI 兼容服务商——自定义条目继承 `openai`，填写 `endpoint` 基础地址与 `api_key_name` 环境变量即可（[官方 README](https://github.com/yetone/avante.nvim#custom-providers)；内置的 `moonshot` / `qwen` 条目在 `lua/avante/config.lua` 中采用同样结构）。将 `endpoint` 指向代理的 `/codebuddy/<spaceId>/v1` 基础地址即可接入——**无需任何代码改动**。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 持有业务用户的 `user_key`（`sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 已在 Neovim（0.10+）中通过插件管理器安装并加载 avante.nvim，并按 [README](https://github.com/yetone/avante.nvim#installation) 配置 `render-markdown.nvim` / `nvim-web-devicons` 等依赖。

## 配置步骤

### 1. 导出 API 密钥

```bash
export MEMORY_PROXY_API_KEY=sk-mem-xxxxxxxx   # 你的业务用户密钥
```

avante 通过 `api_key_name` 解析密钥：先尝试带前缀的 `AVANTE_MEMORY_PROXY_API_KEY`，再尝试普通的 `MEMORY_PROXY_API_KEY`（见 `lua/avante/providers/init.lua`），两个名字均可。

### 2. 声明 provider

在 avante 配置中（以 lazy.nvim 为例）添加继承 OpenAI Chat Completions 协议的 provider 并选中它：

```lua
{
  "yetone/avante.nvim",
  opts = {
    provider = "tencentdb_memory",
    providers = {
      tencentdb_memory = {
        __inherited_from = "openai",
        endpoint = "http://127.0.0.1:8096/codebuddy/default/v1",
        model = "claude-sonnet-4-20250514",
        api_key_name = "MEMORY_PROXY_API_KEY",
      },
    },
  },
}
```

如使用其他记忆空间，将 `default` 替换为对应 space ID。

### 3. 对齐模型 ID

`model` 值**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`，若代理指向其他上游请相应修改。

### 4. 验证

1. 重启 Neovim（或重新加载配置）使 provider 生效。
2. 打开 avante 对话（`:AvanteAsk`）发送首条消息。代理会在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 avante 此前会话记得什么即可确认。

## 配置参考

| 字段（providers 条目） | 值 | 说明 |
|---|---|---|
| `__inherited_from` | `"openai"` | 使用 OpenAI Chat Completions 请求格式 |
| `endpoint` | `http://127.0.0.1:8096/codebuddy/default/v1` | 基础地址；avante 自动拼接 `/chat/completions`；`default` 为记忆空间 ID，按空间替换 |
| `model` | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |
| `api_key_name` | `MEMORY_PROXY_API_KEY` | 存放 `sk-mem-...` 密钥的环境变量；以 `Authorization: Bearer` 发送 |

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| `404` / 连接被拒 | endpoint 拼写错误或代理未在 `:8096` 运行——基础地址必须为 `http://<host>:8096/codebuddy/<spaceId>/v1`；查看 `./start-all.sh` 日志 |
| "Invalid API Key" / 登录提示循环 | 密钥必须是 Panel 的业务用户密钥（`sk-mem-...`）——不是 `./.admin-key` 管理员密钥；确认环境变量在 Neovim 启动环境中已导出 |
| "Model Not Found" / 上游不匹配 | `model` 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开任务可重新选择 |

## 说明

- **仅文档适配器**：provider 配置位于用户自己的 Neovim 配置中，密钥不会落入工作区文件，因此本适配器仅提供文档（与 Kilo Code / Roo Code 适配器一致）。
- **对话与 Agent 模式全覆盖**：avante 的 ask、edit 与 agent 工作流均使用所选 provider，全部获得记忆注入。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
