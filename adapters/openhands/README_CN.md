# TencentDB Agent Memory — OpenHands 适配器

为 [OpenHands](https://github.com/All-Hands-AI/OpenHands) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
OpenHands ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[OpenHands](https://github.com/All-Hands-AI/OpenHands) 的全部 LLM 调用经由 LiteLLM。设置 `LLM_MODEL=openai/<model>` 并配合 `LLM_BASE_URL`，即可将 OpenAI 兼容客户端指向代理的 `/codebuddy/<spaceId>` 端点，无需改动代码。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已安装 OpenHands（`docker pull openhands/all-hands-ai` 或 `pip install openhands-ai`，见 [docs.openhands.dev](https://docs.openhands.dev)）。

## 配置步骤

### 1. 将 OpenHands 指向代理

环境变量方式（推荐，Docker 镜像同样适用）：

```bash
export LLM_MODEL=openai/claude-sonnet-4-20250514
export LLM_BASE_URL=http://127.0.0.1:8096/codebuddy/default
export LLM_API_KEY=sk-mem-...        # 业务用户 key
```

也可固化到 `config.toml`（见本目录 `config.example.toml`）。UI 中对应 **Settings → LLM**：Provider/Model 与 API Key 直接填写，**Base URL** 在 *Advanced* 中设置。

### 2. 对齐模型名

`openai/` 之后的部分**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改。`openai/` 前缀使 LiteLLM 采用 OpenAI 兼容客户端并使用自定义 base URL。

### 3. 验证

1. 新建 OpenHands 会话/任务。
2. 发送首条消息，代理会在会话交互中触发会话选择器：依次选择 **Team → Agent → Task**。
3. 之后每轮自动注入绑定 Agent 的记忆。可让 OpenHands 复述之前会话的记忆以确认生效。

## 配置参考

| 配置项 | 值 | 说明 |
|---|---|---|
| `LLM_MODEL` | `openai/claude-sonnet-4-20250514` | `openai/` 前缀使 LiteLLM 选择 OpenAI 兼容客户端 |
| `LLM_BASE_URL` | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；末尾 `default` 为记忆空间 ID，可按空间替换 |
| `LLM_API_KEY` | `sk-mem-...` | 业务用户 key，以 `Authorization: Bearer` 发送 |
| `LLM_DROP_PARAMS` | `true`（可选） | 丢弃上游不支持的字段（如缓存头），避免直接报错 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 代理返回 `401` | key 缺失或错误——`LLM_API_KEY` 必须为业务用户 key（`sk-mem-...`），不能用管理员 key |
| `404` / 连接被拒 | 代理未在 `:8096` 运行——查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 模型不匹配报错 | `openai/<model>` 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 上游报未知参数错误 | 设置 `LLM_DROP_PARAMS=true`，让 LiteLLM 丢弃不支持的字段而非失败 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新建会话可重新选择 |

## 说明

- **高频调用场景**：OpenHands 每个任务会发起大量 LLM 调用，全部进入绑定 Agent 的 L0 原始对话，恰好是记忆蒸馏所需的输入。
- **UI 同构**：设置界面最终序列化为同一套 `LLM_*` 配置，UI 配置与环境变量配置行为一致。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
