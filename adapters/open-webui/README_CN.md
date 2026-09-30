# TencentDB Agent Memory — Open WebUI 适配器

为 [Open WebUI](https://github.com/open-webui/open-webui) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
Open WebUI ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[Open WebUI](https://github.com/open-webui/open-webui) 通过 **OpenAI API 连接**接入 OpenAI 兼容服务（[官方文档](https://docs.openwebui.com/reference/env-configuration)）：将 `OPENAI_API_BASE_URL` 设为代理的 `/codebuddy/<spaceId>` 端点，即可让全部对话（及可选的后台任务）经过 TencentDB Agent Memory，无需改动代码。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. Open WebUI 已运行（`docker run -d -p 3000:8080 -v open-webui:/app/backend/data --add-host=host.docker.internal:host-gateway ghcr.io/open-webui/open-webui:main`，或 pip 安装，见 [docs.openwebui.com](https://docs.openwebui.com)）。

## 配置步骤

### 1. 将 Open WebUI 指向代理

环境变量方式（首次启动生效，见本目录 `env.example`）：

```bash
OPENAI_API_BASE_URL=http://127.0.0.1:8096/codebuddy/default
OPENAI_API_KEY=sk-mem-...        # 业务用户 key
TASK_MODEL_EXTERNAL=claude-sonnet-4-20250514      # 可选：标题 / 后续问题生成也经由代理
```

也可在 UI 中配置相同内容：**Admin Panel → Settings → Connections → OpenAI API**——填写 URL 与 key 后点击验证按钮。

### 2. 对齐模型 ID

代理每个空间暴露一个上游模型，其 ID **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改。`TASK_MODEL_EXTERNAL` 应使用同一 ID，使后台任务也经过记忆。

### 3. 验证

1. 启动（或重启）Open WebUI，新建对话。
2. 在模型选择器中选择该连接提供的模型。
3. 发送首条消息，代理会在对话交互中触发会话选择器：依次选择 **Team → Agent → Task**。
4. 之后每轮自动注入绑定 Agent 的记忆。可让助手复述之前会话的记忆以确认生效。

## 配置参考

| 配置项 | 值 | 说明 |
|---|---|---|
| `OPENAI_API_BASE_URL` | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；末尾 `default` 为记忆空间 ID，可按空间替换 |
| `OPENAI_API_KEY` | `sk-mem-...` | 业务用户 key，以 `Authorization: Bearer` 发送 |
| `TASK_MODEL_EXTERNAL` | `claude-sonnet-4-20250514` | 可选：标题 / 后续问题生成经由代理的模型 |
| 持久化 | PersistentConfig | 首次启动的环境变量值会存入数据库；后续修改通过 **Admin Panel → Settings** |
| UI 等价项 | Admin Panel → Settings → Connections | 与环境变量同字段 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 连接验证失败 | 检查 URL 是否包含完整空间路径（`/codebuddy/default`），key 是否为业务用户 key（`sk-mem-...`）而非管理员 key |
| `404` / 连接被拒（Docker） | 代理运行在宿主机——`OPENAI_API_BASE_URL` 中用 `host.docker.internal` 替代 `127.0.0.1`，并加 `--add-host=host.docker.internal:host-gateway` |
| 修改环境变量不生效 | `OPENAI_API_BASE_URL` 属 PersistentConfig——首次写入数据库后，需在 **Admin Panel → Settings → Connections** 中修改 |
| 连接下无模型列表 | 模型列表来自连接的 models 端点；若代理版本未提供，请在 Admin Panel → Models 手动注册 ID = `PROXY_UPSTREAM_MODEL` 的模型 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开对话可重新选择 |

## 说明

- **对话型界面**：Open WebUI 是对话式 UI，本适配器将记忆代理变成具备团队记忆的聊天助手——每段对话都被捕获为 L0 原始记录并获得 L2/L3 注入。
- **后台任务**：设置 `TASK_MODEL_EXTERNAL` 后，自动标题与后续问题建议也经由代理并进入记忆。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
