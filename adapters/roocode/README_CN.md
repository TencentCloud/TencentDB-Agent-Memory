# TencentDB Agent Memory — Roo Code 适配器

为 [Roo Code](https://roocode.com) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
Roo Code ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[Roo Code](https://roocode.com) 在设置面板内置 **OpenAI Compatible** API Provider。代理在 `/codebuddy/<spaceId>` 端点提供 OpenAI Chat Completions 协议，因此只需**三个配置项**即可接入，无需改动代码。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已在 VS Code 安装 Roo Code（市场扩展 `RooVeterinaryInc.roo-cline`）。

## 配置步骤

### 1. 配置 Provider

1. 打开 VS Code 侧边栏的 Roo Code 面板，点击设置齿轮图标。
2. **API Provider**：选择 `OpenAI Compatible`。
3. **Base URL**：`http://127.0.0.1:8096/codebuddy/default`
4. **API Key**：业务用户 key（`sk-mem-...`）。
5. **Model ID**：`claude-sonnet-4-20250514`。

### 2. 对齐模型 ID

**Model ID 必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改。可在 **Model Configuration** 中按上游模型设置上下文窗口与最大输出 token。

### 3. 验证

1. 在 Roo Code 对话框发送首条消息。
2. 代理会在对话交互中触发会话选择器：依次选择 **Team → Agent → Task**。
3. 之后每轮自动注入绑定 Agent 的记忆。可让 Roo Code 复述之前会话的记忆以确认生效。

## 配置参考

| 字段（Roo Code 设置） | 值 | 说明 |
|---|---|---|
| API Provider | `OpenAI Compatible` | 使用 OpenAI Chat Completions 协议 |
| Base URL | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；末尾 `default` 为记忆空间 ID，可按空间替换 |
| API Key | `sk-mem-...` | 面板创建的业务用户 key，以 `Authorization: Bearer` 发送 |
| Model ID | `claude-sonnet-4-20250514` | 必须与 `PROXY_UPSTREAM_MODEL` 一致，否则代理报上游模型不匹配 |
| Model Configuration | 可选 | 按上游模型设置上下文窗口 / 最大输出 token |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| "Invalid API Key" | 必须使用面板创建的业务用户 key（`sk-mem-...`），不能用 `./.admin-key` 的管理员 key |
| "Model Not Found" / 上游不匹配 | Model ID 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 工具调用报错 | 代理透传 OpenAI 原生工具调用；请确保 `PROXY_UPSTREAM_MODEL` 指向支持工具调用的模型（如 Claude Sonnet 级别） |
| `404` / 连接被拒 | 代理未在 `:8096` 运行——查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开 Roo Code 任务可重新选择 |

## 说明

- **UI 配置**：Roo Code 将 Provider 档案保存在 VS Code 的密钥存储中，密钥不会落入工作区文件，因此本适配器仅提供文档（与 Cline 适配器一致）。
- **模式全覆盖**：Roo Code 的各模式（Code/Architect/Ask/Debug）走同一 Provider，均能获得记忆注入。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
