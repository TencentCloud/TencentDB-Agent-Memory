# TencentDB Agent Memory — LobeChat 适配器

为 [LobeChat](https://github.com/lobehub/lobe-chat) 注入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每段对话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入系统提示词
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
LobeChat ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                         │
                                         ├─ auth        (校验 sk-mem-... user_key)
                                         ├─ sessionInit (Team/Agent/Task 选择器)
                                         └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

LobeChat 内置 OpenAI Provider 支持 `OPENAI_PROXY_URL` 环境变量覆盖默认 OpenAI 基础地址（[官方部署文档](https://lobehub.com/zh/docs/self-hosting/environment-variables/basic)）。将其指向代理的 `/codebuddy/<spaceId>` 端点即可接入——**无需任何代码改动**。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 持有业务用户的 `user_key`（`sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 已部署 LobeChat（Docker 或 Vercel——见[官方文档](https://lobehub.com/zh/docs/self-hosting/platform/docker-compose)）。

## 配置步骤

### 1. 将 LobeChat 的 OpenAI Provider 指向代理

Docker 部署示例：

```bash
docker run -d -p 3210:3210 \
  -e OPENAI_API_KEY=sk-mem-xxxxxxxx \
  -e OPENAI_PROXY_URL=http://127.0.0.1:8096/codebuddy/default \
  -e OPENAI_MODEL_LIST=+claude-sonnet-4-20250514 \
  -e ACCESS_CODE=your-access-code \
  --name lobe-chat lobehub/lobe-chat
```

- `OPENAI_API_KEY` — 业务用户密钥（`sk-mem-...`）
- `OPENAI_PROXY_URL` — 代理端点；如使用其他记忆空间，将 `default` 替换为对应 space ID。请原样填写、**不要**以 `/v1` 结尾（代理的 `/codebuddy/<spaceId>` 路径不含 `/v1` 段；LobeChat 会自行拼接 chat-completions 路径）
- `OPENAI_MODEL_LIST` — 将代理的上游模型加入模型选择器
- `ACCESS_CODE` — LobeChat 实例的访问保护（建议开启）

已有部署可在 `docker-compose.yml` / 托管环境中设置相同变量，或运行时在 **设置 → 语言模型 → OpenAI** 中配置（API 代理地址 + API Key）。

### 2. 对齐模型 ID

模型名**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`，若代理指向其他上游请相应修改。

### 3. 验证

1. 打开 LobeChat（`http://localhost:3210`），输入访问码，选择 `claude-sonnet-4-20250514` 模型。
2. 发送首条消息。代理会在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 LobeChat 此前对话记得什么即可确认。

## 配置参考

| 变量 | 值 | 说明 |
|---|---|---|
| `OPENAI_PROXY_URL` | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；`default` 为记忆空间 ID，按空间替换；结尾不带 `/v1` |
| `OPENAI_API_KEY` | `sk-mem-...` | Panel 创建的业务用户密钥；以 `Authorization: Bearer` 发送 |
| `OPENAI_MODEL_LIST` | `+claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |
| `ACCESS_CODE` | 任意强口令 | 保护 LobeChat 实例（可选，建议开启） |

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| `401` / "Invalid API Key" | 密钥必须是 Panel 的业务用户密钥（`sk-mem-...`）——不是 `./.admin-key` 管理员密钥 |
| AI 返回空消息 | `OPENAI_PROXY_URL` 后缀不匹配——**不要**追加 `/v1`；必须恰为 `http://<host>:8096/codebuddy/<spaceId>` |
| "Model Not Found" / 上游不匹配 | 模型名与 `PROXY_UPSTREAM_MODEL` 不一致——对齐并检查 `OPENAI_MODEL_LIST` |
| `404` / 连接被拒 | 代理未在 `:8096` 运行——查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开话题可重新选择 |

## 说明

- **环境变量配置**：密钥仅存在于 LobeChat 的环境/运行时设置中，不落入被提交的文件，因此本适配器仅提供文档（与 Open WebUI / LibreChat 适配器一致）。
- **所有对话全覆盖**：使用该模型的所有话题均获得记忆注入——助手、Agent 与插件皆然。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
