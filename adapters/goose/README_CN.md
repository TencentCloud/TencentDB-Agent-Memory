# TencentDB Agent Memory — Goose 适配器

为 [Goose](https://github.com/block/goose) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
Goose ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[Goose](https://github.com/block/goose) 内置 `openai` Provider，其 host 与 base path 均可配置（`OPENAI_HOST` + `OPENAI_BASE_PATH`）。将二者指向代理的 `/codebuddy/<spaceId>` 端点，即可让 Goose 的全部 LLM 流量经过 TencentDB Agent Memory，无需改动代码。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已安装 Goose（`brew install block-goose-cli` 或使用 [block.github.io/goose](https://block.github.io/goose) 的安装脚本）。

## 配置步骤

### 1. 将 Goose 指向代理

环境变量方式（快速开始）：

```bash
export GOOSE_PROVIDER=openai
export GOOSE_MODEL=claude-sonnet-4-20250514
export OPENAI_HOST=http://127.0.0.1:8096
export OPENAI_BASE_PATH=/codebuddy/default
export OPENAI_API_KEY=sk-mem-...        # 业务用户 key
```

也可将前四项固化到 `~/.config/goose/config.yaml`（见本目录 `config.example.yaml`），仅 `OPENAI_API_KEY` 保留在环境变量/钥匙串中，避免密钥进入版本库。桌面版读取同一配置文件。

### 2. 对齐模型名

`GOOSE_MODEL` **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改。

### 3. 验证

1. `goose session` 启动会话（或运行桌面版）。
2. 发送首条消息，代理会在终端交互中触发会话选择器：依次选择 **Team → Agent → Task**。
3. 之后每轮自动注入绑定 Agent 的记忆。可让 Goose 复述之前会话的记忆以确认生效；`goose info -v` 可查看生效的 Provider 配置。

## 配置参考

| 配置项 | 值 | 说明 |
|---|---|---|
| `GOOSE_PROVIDER` | `openai` | 使用 Goose 内置 OpenAI Provider（无需自定义 Provider 条目） |
| `OPENAI_HOST` | `http://127.0.0.1:8096` | 代理主机；与 base path 拼接成完整端点 |
| `OPENAI_BASE_PATH` | `/codebuddy/default` | `default` 为记忆空间 ID，可按空间替换 |
| `OPENAI_API_KEY` | `sk-mem-...` | 业务用户 key，以 `Authorization: Bearer` 发送 |
| `GOOSE_MODEL` | `claude-sonnet-4-20250514` | 必须与 `PROXY_UPSTREAM_MODEL` 一致，否则代理报上游模型不匹配 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| Goose 拒绝启动 / 提示未配置模型 | 必须设置 `GOOSE_MODEL`——缺少该配置 Goose 无法启动 |
| 请求仍发往 api.openai.com | `OPENAI_HOST` 未生效——在启动 Goose 的 shell 中设置，或固化到 `~/.config/goose/config.yaml` |
| 代理返回 `401` | key 缺失或错误——`OPENAI_API_KEY` 必须为业务用户 key（`sk-mem-...`），不能用管理员 key |
| `404` / 连接被拒 | 代理未在 `:8096` 运行，或 `OPENAI_BASE_PATH` 配置有误——查看 `./start-all.sh` 日志 |
| 模型不匹配报错 | `GOOSE_MODEL` 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开 Goose 会话可重新选择 |

## 说明

- **终端 + 桌面同源**：Goose CLI 与桌面版共用 `~/.config/goose/config.yaml`，配置一次两端生效。
- **MCP 不受影响**：Goose 的 MCP 扩展照常工作，仅 LLM 链路经由代理。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
