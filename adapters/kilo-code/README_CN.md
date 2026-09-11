# TencentDB Agent Memory — Kilo Code 适配器

为 [Kilo Code](https://github.com/Kilo-Org/kilocode) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
Kilo Code ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[Kilo Code](https://github.com/Kilo-Org/kilocode) 支持 **Custom provider**，其 **Provider API** 可设为 **OpenAI Compatible**（[官方文档](https://kilocode.ai/docs/providers/openai-compatible)）。将其 Base URL 指向代理的 `/codebuddy/<spaceId>` 端点即可接入，**无需改动代码**。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已在 VS Code 安装 Kilo Code（扩展市场搜索 "Kilo Code"，见 [kilocode.ai/docs](https://kilocode.ai/docs)）。

## 配置步骤

### 1. 将代理注册为自定义 Provider

1. 打开 **Settings**（齿轮图标），进入 **Providers** 标签。
2. 滚动到底部，点击 **Custom provider**。
3. 在弹窗中填写：
   - **Provider ID**：`tdb-agent-memory`
   - **Display name**：`TencentDB Agent Memory`
   - **Provider API**：`OpenAI Compatible`
   - **Base URL**：`http://127.0.0.1:8096/codebuddy/default`
   - **API key**：业务用户 key（`sk-mem-...`）
   - **Models**：添加 ID 为 `claude-sonnet-4-20250514` 的模型——可自动检测（Kilo 会查询 Provider 的 models 端点），也可 **Add model manually** 手动添加
4. 点击 **Submit** 保存，模型的条目即出现在模型选择器中。

### 2. 对齐模型 ID

模型 ID **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改。条目的 token 上限 / 工具调用开关可随后在 `kilo.jsonc`（Kilo 的模型配置文件）中细化。

### 3. 验证

1. 打开 Kilo Code 面板，在模型选择器中选择 **TencentDB Agent Memory** 及模型条目。
2. 发送首条消息，代理会在对话交互中触发会话选择器：依次选择 **Team → Agent → Task**。
3. 之后每轮自动注入绑定 Agent 的记忆。可让 Kilo Code 复述之前会话的记忆以确认生效。

## 配置参考

| 字段（自定义 Provider 弹窗） | 值 | 说明 |
|---|---|---|
| Provider API | `OpenAI Compatible` | 使用 OpenAI Chat Completions 协议 |
| Base URL | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；末尾 `default` 为记忆空间 ID，可按空间替换 |
| API key | `sk-mem-...` | 面板创建的业务用户 key，以 `Authorization: Bearer` 发送 |
| Model ID | `claude-sonnet-4-20250514` | 必须与 `PROXY_UPSTREAM_MODEL` 一致，否则代理报上游模型不匹配 |
| `kilo.jsonc` | 可选 | 为已添加的模型条目细化上下文窗口 / token 上限 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| "Invalid API Key" | 必须使用面板创建的业务用户 key（`sk-mem-...`），不能用 `./.admin-key` 的管理员 key |
| 自动检测不到模型 | 自动检测依赖 Provider 的 models 端点；若代理版本未提供，请用 **Add model manually** 手动添加 ID = `PROXY_UPSTREAM_MODEL` |
| "Model Not Found" / 上游不匹配 | Model ID 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| `404` / 连接被拒 | 代理未在 `:8096` 运行——查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开任务可重新选择 |

## 说明

- **UI 配置**：Kilo Code 将自定义 Provider 档案保存在 VS Code 的密钥存储中，密钥不会落入工作区文件，因此本适配器仅提供文档（与 Roo Code / Cline 适配器一致）。
- **模式全覆盖**：Kilo Code 的各模式（Orchestrator/Coder/Architect/Ask...）均使用所选 Provider，全部获得记忆注入。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
