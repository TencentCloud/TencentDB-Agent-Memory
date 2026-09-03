# TencentDB Agent Memory — Crush 适配器

为 [Crush](https://github.com/charmbracelet/crush) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
Crush ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[Crush](https://github.com/charmbracelet/crush) 支持在 JSON 配置中声明 `openai-compat` 类型的自定义 Provider。代理在 `/codebuddy/<spaceId>` 端点提供 OpenAI Chat Completions 协议，因此只需**一个 Provider 条目**即可接入，无需改动代码。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已安装 Crush（`brew install charmbracelet/tap/crush` 或 `npm install -g @charmland/crush`）。

## 配置步骤

### 1. 将代理注册为 Crush Provider

将本目录的 `crush.example.json` 复制为 `~/.config/crush/crush.json`（全局）或项目根目录的 `crush.json`（项目级，优先级更高），密钥保留在环境变量中：

```bash
export TDB_MEM_USER_KEY=sk-mem-...     # 业务用户 key
```

Crush 会从环境变量展开 `$TDB_MEM_USER_KEY`，密钥不会进入版本库。

### 2. 对齐模型 ID

模型 `id` **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改。

### 3. 验证

1. 在项目目录启动 `crush`。
2. `Ctrl+L`（或 `/model`）打开模型切换器，选择 **TencentDB Agent Memory** 及模型条目。
3. 发送首条消息，代理会在终端交互中触发会话选择器：依次选择 **Team → Agent → Task**。
4. 之后每轮自动注入绑定 Agent 的记忆。可让 Crush 复述之前会话的记忆以确认生效。

## 配置参考

| 配置项 | 值 | 说明 |
|---|---|---|
| `providers.*.type` | `openai-compat` | Crush 的 OpenAI 兼容 Provider 类型 |
| `base_url` | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；末尾 `default` 为记忆空间 ID，可按空间替换 |
| `api_key` | `$TDB_MEM_USER_KEY` | 环境变量引用，变量值为 `sk-mem-...` 业务用户 key |
| `models[].id` | `claude-sonnet-4-20250514` | 必须与 `PROXY_UPSTREAM_MODEL` 一致，否则代理报上游模型不匹配 |
| 配置位置 | `~/.config/crush/crush.json` 或 `./crush.json` | 项目级配置优先，详见 Crush README |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 模型切换器中看不到 Provider | `crush.json` JSON 语法错误——用 `python3 -m json.tool crush.json` 校验；并确认文件位置符合加载顺序 |
| 代理返回 `401` | key 缺失或错误——启动 Crush 的 shell 中必须导出 `TDB_MEM_USER_KEY`，且为业务用户 key（`sk-mem-...`），不能用管理员 key |
| `404` / 连接被拒 | 代理未在 `:8096` 运行——查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 模型不匹配报错 | `models[].id` 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开 Crush 会话可重新选择 |

## 说明

- **终端原生**：代理的 Team → Agent → Task 交互式选择器直接内嵌在 Crush 的 TUI 中渲染，与 CodeBuddy 终端流程一致。
- **多模型**：可在 `models[]` 中声明多个条目（对应代理暴露的多个上游），会话中用 `/model` 切换，上下文按会话保留。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
