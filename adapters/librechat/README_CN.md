# TencentDB Agent Memory — LibreChat 适配器

为 [LibreChat](https://github.com/danny-avila/LibreChat) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
LibreChat ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[LibreChat](https://github.com/danny-avila/LibreChat) 在 `librechat.yaml` 中支持 OpenAI 兼容服务的**自定义端点**（[官方文档](https://www.librechat.ai/docs/quick_start/custom_endpoints)）：一个 `endpoints.custom` 条目将 `baseURL` 指向代理的 `/codebuddy/<spaceId>` 端点，即得到具备记忆能力的对话端点，无需改动代码。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. LibreChat 已运行（Docker 或 npm 部署，见 [www.librechat.ai/docs](https://www.librechat.ai/docs)）。

## 配置步骤

### 1. 添加自定义端点

将本目录的 `librechat.example.yaml` 复制到 LibreChat 项目根目录并命名为 `librechat.yaml`（或将 `endpoints.custom` 条目合并进现有配置）。在 `.env` 中添加密钥：

```bash
TDB_MEM_USER_KEY=sk-mem-...     # 业务用户 key
```

`${TDB_MEM_USER_KEY}` 引用方式使密钥不会进入版本库。

### 2. 挂载配置文件（仅 Docker）

确认 `docker-compose.override.yml` 已挂载：

```yaml
services:
  api:
    volumes:
      - type: bind
        source: ./librechat.yaml
        target: /app/librechat.yaml
```

### 3. 对齐模型 ID

`models.default[0]` **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改。除非代理提供模型列表端点，否则保持 `fetch: false`。

### 4. 验证

1. 重启：`docker compose down && docker compose up -d`（本地运行则重启 `npm run backend`）。
2. 端点选择下拉中出现 **TencentDB Agent Memory**——选中它及模型。
3. 发送首条消息，代理会在对话交互中触发会话选择器：依次选择 **Team → Agent → Task**。
4. 之后每轮自动注入绑定 Agent 的记忆。可让助手复述之前会话的记忆以确认生效。

## 配置参考

| 配置项 | 值 | 说明 |
|---|---|---|
| `endpoints.custom[].name` | `TencentDB Agent Memory` | 端点下拉中显示的名称 |
| `baseURL` | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；末尾 `default` 为记忆空间 ID，可按空间替换 |
| `apiKey` | `${TDB_MEM_USER_KEY}` | 环境变量引用，由 `.env` 解析，值为 `sk-mem-...` 业务用户 key |
| `models.default[0]` | `claude-sonnet-4-20250514` | 必须与 `PROXY_UPSTREAM_MODEL` 一致，否则代理报上游模型不匹配 |
| `models.fetch` | `false` | 仅当代理提供模型列表端点时开启 |
| `titleConvo` | `false` | 可选：自动标题生成会经由代理发起额外调用 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 下拉中看不到端点 | 查看 `docker compose logs api`——常见为 YAML 语法错误、`.env` 缺项，或 Docker 下未挂载 `librechat.yaml` |
| 代理返回 `401` | key 缺失或错误——`.env` 中的 `TDB_MEM_USER_KEY` 必须为业务用户 key（`sk-mem-...`），不能用管理员 key |
| `404` / 连接被拒 | 代理未在 `:8096` 运行，或 `baseURL` 拼写有误——查看 `./start-all.sh` 日志 |
| 模型不匹配报错 | `models.default[0]` 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 标题生成报错 | 按示例设置 `titleConvo: false`，或将 `titleModel` 指向同一代理模型 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开对话可重新选择 |

## 说明

- **对话型界面**：LibreChat 是对话式 UI，本适配器将记忆代理变成具备团队记忆的聊天助手——每段对话都被捕获为 L0 原始记录并获得 L2/L3 注入。
- **多用户安全**：LibreChat 自带用户级界面认证；代理 key 仅保存在服务端 `.env`，各用户在首条消息中选择自己的 Team → Agent → Task 绑定。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
