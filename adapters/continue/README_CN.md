# TencentDB Agent Memory — Continue 适配器

为 [Continue](https://docs.continue.dev) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
Continue ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[Continue](https://docs.continue.dev) 在 `config.yaml` 中通过 `provider: openai` 加自定义 `apiBase` 支持 OpenAI 兼容服务。将 `apiBase` 指向代理的 `/codebuddy/<spaceId>` 端点，即可让 chat/edit/apply 全部经由 TencentDB Agent Memory，无需改动代码。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已在 VS Code / JetBrains 安装 Continue 扩展（见 [docs.continue.dev](https://docs.continue.dev)）。

## 配置步骤

### 1. 在 Continue 中注册模型

将本目录的 `config.example.yaml` 复制为 `~/.continue/config.yaml`（或将 `models` 条目合并进现有配置），并导出密钥：

```bash
export TDB_MEM_USER_KEY=sk-mem-...     # 业务用户 key
```

Continue 保存配置后自动重载；密钥保留在环境变量中，不会进入版本库。

### 2. 对齐模型 ID

`model` 字段**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改。

### 3. 验证

1. 重载 VS Code 窗口（`Ctrl/Cmd+Shift+P` → `Developer: Reload Window`）。
2. 打开 Continue 侧边栏，在模型下拉中选择 **TencentDB Memory**。
3. 发送首条消息，代理会在对话交互中触发会话选择器：依次选择 **Team → Agent → Task**。
4. 之后每轮自动注入绑定 Agent 的记忆。可让 Continue 复述之前会话的记忆以确认生效。

## 配置参考

| 配置项 | 值 | 说明 |
|---|---|---|
| `provider` | `openai` | Continue 的 OpenAI 兼容适配器 |
| `apiBase` | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；末尾 `default` 为记忆空间 ID，可按空间替换 |
| `apiKey` | `${TDB_MEM_USER_KEY}` | 环境变量引用，变量值为 `sk-mem-...` 业务用户 key |
| `model` | `claude-sonnet-4-20250514` | 必须与 `PROXY_UPSTREAM_MODEL` 一致，否则代理报上游模型不匹配 |
| `roles` | `chat`、`edit`、`apply` | 三个角色均经由代理 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| "No models configured" / 配置未加载 | `name`、`version`、`schema` 为必填顶层字段——缺失任一项整份配置解析失败；同时检查 YAML 缩进 |
| 代理返回 `401` | key 缺失或错误——启动 VS Code 的 shell 中必须导出 `TDB_MEM_USER_KEY`，且为业务用户 key（`sk-mem-...`） |
| `404` / 连接被拒 | 代理未在 `:8096` 运行，或 `apiBase` 误填了完整 `/chat/completions` 路径——只填端点根 `http://127.0.0.1:8096/codebuddy/default` |
| 模型不匹配报错 | `model` 字段与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开对话可重新选择 |

## 说明

- **维护状态**：`continuedev/continue` 仓库止于最终版 2.0.0；已安装扩展的自定义 `apiBase` 能力仍然有效，本适配器即依赖该能力。
- **自动补全不建议接入**：行内补全对延迟敏感——建议仅 `chat`/`edit`/`apply` 走代理，补全保持直连。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
