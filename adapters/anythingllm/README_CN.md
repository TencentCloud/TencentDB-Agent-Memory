# TencentDB Agent Memory — AnythingLLM 适配器

为 [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) 装上持久团队记忆。本适配器把其 LLM 流量路由到 TencentDB Agent Memory 代理，每个工作区对话自动获得：

- **会话绑定** —— 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** —— 绑定 Agent 的 L2/L3 记忆、技能与知识在每一轮混入系统提示词
- **自动沉淀** —— L0 原始对话写入 memory-core，供后续蒸馏

## 工作原理

```
AnythingLLM ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游 LLM
                                             │
                                             ├─ auth        (校验 sk-mem-... user_key)
                                             ├─ sessionInit (Team/Agent/Task 选择器)
                                             └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

AnythingLLM 的 **Generic OpenAI** LLM provider 可对接任意 OpenAI 兼容端点——Base URL 与 API Key 既可在 UI 配置也可用环境变量。该 provider 基于 OpenAI SDK 实现，Base URL 原样透传并在其后追加 `/chat/completions`（已核实源码：`server/utils/AiProviders/genericOpenAi/index.js` 以 `baseURL: GENERIC_OPEN_AI_BASE_PATH` 构建客户端；设置层仅做 URL 合法性校验，不会改写路径）。把 Base URL 指向代理的 `/codebuddy/<spaceId>/v1` 端点即可接入——**无需改任何代码**。

**会话绑定**（首条消息触发 Team → Agent → Task 选择器）、**记忆注入**（绑定 Agent 的 L2/L3 记忆、技能与知识每轮混入系统提示词）与**自动沉淀**（L0 原始对话写入 memory-core）全部开箱即用。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. AnythingLLM 已运行（桌面版或 Docker，见[官方文档](https://docs.anythingllm.com/)）。

## 配置步骤

### 1. 把 AnythingLLM 的 Generic OpenAI provider 指向代理

在 AnythingLLM UI 中：打开 **Settings → AI Providers → LLM**，选择 **Generic OpenAI**，填写：

- **Base URL**：`http://127.0.0.1:8096/codebuddy/default/v1` —— 若使用其他记忆空间，把 `default` 换成对应 spaceId。**保留末尾 `/v1`**：AnythingLLM 将 Base URL 原样传给 OpenAI SDK，后者追加 `/chat/completions`，正好落在代理的 `/codebuddy/<spaceId>/v1/chat/completions` 路由上。
- **API Key**：业务用户密钥（`sk-mem-...`）。
- **Chat Model**：代理的 `PROXY_UPSTREAM_MODEL` 值（如 `claude-sonnet-4-20250514`）。**必须与**代理上游模型一致，否则代理以上游不匹配为由拒绝。

保存设置。

Docker 部署也可改用环境变量完成同样配置：

```bash
GENERIC_OPEN_AI_BASE_PATH=http://127.0.0.1:8096/codebuddy/default/v1
GENERIC_OPEN_AI_API_KEY=sk-mem-xxxxxxxx
GENERIC_OPEN_AI_MODEL_PREF=claude-sonnet-4-20250514
```

### 2. 验证

1. 打开 AnythingLLM 工作区对话，确认当前模型为 Generic OpenAI 所配模型。
2. 发送第一条消息。代理在聊天交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从这一轮起，绑定 Agent 的记忆自动注入。向 AnythingLLM 询问之前对话记得什么即可确认。

## 配置速查

| 字段 / 变量 | 值 | 说明 |
|---|---|---|
| Base URL / `GENERIC_OPEN_AI_BASE_PATH` | `http://127.0.0.1:8096/codebuddy/default/v1` | 代理端点；`default` 为记忆空间 ID，按空间替换；**保留**末尾 `/v1` |
| API Key / `GENERIC_OPEN_AI_API_KEY` | `sk-mem-...` | Panel 创建的业务用户密钥；以 `Authorization: Bearer` 发送 |
| Chat Model / `GENERIC_OPEN_AI_MODEL_PREF` | `PROXY_UPSTREAM_MODEL` 的值（如 `claude-sonnet-4-20250514`） | 必须与代理上游模型一致 |

## 故障排查

| 症状 | 原因 / 解决 |
|---|---|
| `401` / "Invalid API Key" | 必须使用 Panel 的业务用户密钥（`sk-mem-...`），不能用 `./.admin-key` 的管理员密钥 |
| AI 回复为空 / 上游不匹配 | Chat Model 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 每次请求都 `404` | Base URL 末尾漏了 `/v1`（请求会打到 `/codebuddy/<spaceId>/chat/completions`）；按上文原样填写 Base URL |
| 连接被拒 | 代理未在 `:8096` 运行——检查 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量；Docker 部署中 `127.0.0.1` 需解析到代理所在主机（代理在 Docker 宿主机上时改用 `host.docker.internal`） |
| 会话选择器未出现 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动设置）；若前一会话已绑定任务，绑定会被复用——新开对话即可重新选择 |

## 说明

- **配置仅存于应用本地**：Base URL 与密钥只保存在 AnythingLLM 设置/环境变量中，不进入任何提交文件；因此本适配器只包含文档（与 LobeChat / Open WebUI / LibreChat 适配器一致）。
- **全部工作区对话经过代理**：所有使用 Generic OpenAI 模型的对话（含 agent）都会获得记忆注入。
- **数据流**：仅提示词/补全流经代理；记忆数据保留在本地 SQLite（memory-core）中，除非你另行配置。

## 许可证

MIT，与主仓库一致。
