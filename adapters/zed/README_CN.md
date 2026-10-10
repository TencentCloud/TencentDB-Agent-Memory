# TencentDB Agent Memory — Zed 适配器

为 [Zed](https://zed.dev) 编辑器的 AI 功能装上团队级持久记忆。本适配器将 Zed 的 LLM 请求路由到 TencentDB Agent Memory 代理，使 Zed Agent、Inline Assistant 等模型功能自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每一轮对话自动将所绑定 Agent 的 L2/L3 记忆、技能与知识注入系统提示词
- **自动沉淀** — L0 原始对话自动写入 memory-core，供后续提炼

## 工作原理

```
Zed ──(OpenAI Chat Completions 协议)──> Memory Proxy :8096 ──> 上游 LLM
                                           │
                                           ├─ auth        (校验 sk-mem-... user_key)
                                           ├─ sessionInit (Team/Agent/Task 选择器)
                                           └─ injection   (注入 L2/L3 记忆 + 技能 + 知识)
```

Zed 在 `settings.json` 的 `language_models.openai_compatible` 下支持自定义 OpenAI 兼容 provider。代理在 `/codebuddy/<spaceId>` 端点上说 OpenAI Chat Completions 协议，因此 Zed **纯配置接入**。

## 前置条件

1. TencentDB Agent Memory 已启动（使用主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获取业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时 `start-all.sh` 会打印；也可在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已安装 Zed（[zed.dev/download](https://zed.dev/download)）。

## 配置步骤

### 1. 注册 provider

打开 Zed 设置文件（命令面板执行 `zed: open settings`），将本目录 `settings.example.json` 的内容合并进你的 `settings.json`：

```json
{
  "language_models": {
    "openai_compatible": {
      "tencentdb-agent-memory": {
        "api_url": "http://127.0.0.1:8096/codebuddy/default",
        "custom_headers": { "x-tdai-service-id": "default" },
        "available_models": [
          {
            "name": "claude-sonnet-4-20250514",
            "display_name": "claude-sonnet-4 (via Memory Proxy)",
            "max_tokens": 200000,
            "max_output_tokens": 16384,
            "capabilities": { "tools": true, "images": false, "chat_completions": true }
          }
        ]
      }
    }
  }
}
```

然后调整一个字段：模型 `name` **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。默认示例使用 `claude-sonnet-4-20250514`。`max_tokens` 为上下文窗口大小，按上游模型对齐。

### 2. 提供密钥

Zed 根据 provider ID 生成环境变量：**`tencentdb-agent-memory` → `TENCENTDB_AGENT_MEMORY_API_KEY`**。启动 Zed 前导出：

```bash
export TENCENTDB_AGENT_MEMORY_API_KEY="sk-mem-..."   # 你的业务用户密钥
```

或在 Zed 中执行 `agent: open settings`，添加该 provider 并在 UI 中粘贴密钥（存入 Zed 凭据存储，不会写入 `settings.json`）。

### 3. 验证

1. 重启 Zed（或 reload），打开助手面板，在 `tencentdb-agent-memory` provider 下选择 **claude-sonnet-4 (via Memory Proxy)**。
2. 发送第一条消息。代理会触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，所绑定 Agent 的记忆将自动注入。可以让 Zed 回忆此前会话内容进行验证。

## 配置参考

| 字段 | 值 | 说明 |
|---|---|---|
| `api_url` | `http://127.0.0.1:8096/codebuddy/default` | 代理的 OpenAI 兼容端点；末尾 `default` 为记忆空间 ID，多空间时对应修改 |
| `custom_headers` | `x-tdai-service-id: default` | 多空间部署时显式指定服务 ID（`Authorization` 由 Zed 管理） |
| `available_models[].name` | 必须等于 `PROXY_UPSTREAM_MODEL` | 否则代理会因上游模型不匹配而拒绝请求 |
| `available_models[].max_tokens` | `200000` | 上游模型的上下文窗口（Zed 必填字段） |
| `capabilities.tools` | `true` | Zed Agent 的 agentic 工作流需要工具调用 |
| 密钥 | `TENCENTDB_AGENT_MEMORY_API_KEY` 环境变量或设置 UI | provider ID 转大写蛇形 + `_API_KEY` |

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 助手面板中无此 provider | `settings.json` 解析失败或配置块不在 `language_models.openai_compatible` 之下 —— 查看 `zed --foreground` 日志 |
| 模型可见但认证失败 | 密钥缺失 —— 导出 `TENCENTDB_AGENT_MEMORY_API_KEY` 或经 `agent: open settings` 添加 |
| 代理返回 `401` | 密钥错误 —— 确认使用业务用户密钥（`sk-mem-...`）而非管理员密钥 |
| `404` / 连接被拒 | 代理未在 `:8096` 运行 —— 查看 `./start-all.sh` 日志及 `PROXY_UPSTREAM_*` 环境变量 |
| 模型不匹配报错 | 所选模型与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐 `available_models[].name` |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动开启）；若此前会话已绑定 Task 会复用绑定 —— 新开一个助手线程即可重新选择 |

## 说明

- **作用范围**：本配置作用于 Zed 自有的 AI 功能（Zed Agent、Inline Assistant、提交信息生成等）。External Agents 与 Terminal Threads 自行管理模型接入。
- **端点前缀**：复用代理的 OpenAI 兼容端点（`/codebuddy/<spaceId>`）；待上游提供专用前缀后，仅需修改 `api_url`。
- **数据流**：只有提示词/补全流量经过代理；记忆数据始终保存在本地 SQLite（memory-core）中，除非你另行配置。
- **版本**：已在 Zed 的 `openai_compatible` 设置规范（见官方 LLM 文档）与 TencentDB Agent Memory v3（`feat/server_team` 分支，v2.0.0 镜像）上验证。

## 许可证

MIT，与主仓库一致。
