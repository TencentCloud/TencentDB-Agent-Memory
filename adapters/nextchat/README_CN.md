# TencentDB Agent Memory — NextChat 适配器

为 [NextChat](https://github.com/ChatGPTNextWeb/NextChat) 注入持久团队记忆。NextChat（ChatGPT-Next-Web）是广泛使用的可自托管 / 桌面 / 移动端 ChatGPT Web UI。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，使每次对话都获得：

- **会话绑定** — 首条消息触发交互式 Team → Agent → Task 选择器
- **记忆注入** — 每一轮都将所绑定 agent 的 L2/L3 记忆、技能与知识融入 system prompt
- **自动捕获** — L0 原始对话被持久化到 memory-core，供后续蒸馏

## 工作原理

```
NextChat ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                           │
                                           ├─ auth        (校验 sk-mem-... user_key)
                                           ├─ sessionInit (Team/Agent/Task 选择器)
                                           └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

NextChat 默认的 OpenAI provider 以「接口地址 + `v1/chat/completions`」拼接请求 URL（源码核实：`app/client/platforms/openai.ts` — `path()` 从 access store 读取自定义接口地址，剥离尾部斜杠后拼接 `OpenaiPath.ChatPath` = `"v1/chat/completions"`，定义于 `app/constant.ts`），并以标准 `Authorization` 头携带密钥（源码核实：`app/client/api.ts` — `getHeaders()`）。将接口地址指向代理的 `/codebuddy/<spaceId>` 端点即可接入 — **无需改动任何代码**。

注意：客户端会自行追加 `v1/chat/completions`，因此接口地址**不得**以 `/v1` 结尾。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键启动栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（`sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. NextChat 已运行 — [桌面版](https://github.com/ChatGPTNextWeb/NextChat/releases)、你自有的托管实例，或自托管部署（docker / Vercel，见[官方文档](https://github.com/ChatGPTNextWeb/NextChat#getting-started)）。

## 配置（应用内自定义接口）

### 1. 配置自定义接口

打开 **设置 → 自定义接口**，启用并填写：

- **接口地址** — `http://127.0.0.1:8096/codebuddy/default`
- **API Key** — 你的 `sk-mem-...` 业务用户密钥

若使用其他 space，将 `default` 替换为你的记忆空间 ID。务必保留完整 `http://` 前缀：裸主机名会被自动补上 `https://`（源码核实：`app/client/platforms/openai.ts` — `path()` 对不以 `http` 开头的地址前置 `https://`）。**不要**追加尾部 `/v1` — 客户端自行拼接 `v1/chat/completions`，恰好落位代理的 `/codebuddy/<spaceId>/v1/chat/completions` 路由。

### 2. 手动声明模型

模型选择器的 *获取模型列表* 按钮会调用 `GET <地址>/v1/models`（源码核实：`app/client/platforms/openai.ts` — `ListModelPath`），代理未暴露该端点 — 列表保持为空。属预期行为：改为在 **自定义模型** 字段填入模型 ID，如 `claude-sonnet-4-20250514`。自定义模型条目会被解析进可选模型列表（源码核实：`app/store/access.ts` — `customModels` 字段，由 `app/utils/model.ts` 消费）。

模型 provider 保持 **OpenAI**（默认），以确保走上述 OpenAI 兼容路径。

模型 ID **必须**与代理的 `PROXY_UPSTREAM_MODEL` 一致，否则代理以上游不匹配拒绝。

### 3. 对话验证

1. 在模型选择器中选择自定义模型并新建话题。
2. 发送首条消息。代理在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起自动注入所绑定 agent 的记忆。询问 NextChat 是否记得之前的对话即可确认。

## 配置（自托管部署，备选）

对于自托管 NextChat（docker / Vercel），同样的接线可通过服务端环境变量完成 — 应用服务端路由会将默认 OpenAI 调用转发至 `BASE_URL`（源码核实：`app/config/server.ts` — `baseUrl: process.env.BASE_URL`；`app/api/common.ts` — `requestOpenai()` 在剥离 `/api/openai/` 前缀后拼接请求路径）：

```bash
BASE_URL=http://<proxy-host>:8096/codebuddy/default
OPENAI_API_KEY=sk-mem-...
CUSTOM_MODELS=claude-sonnet-4-20250514   # 必须与 PROXY_UPSTREAM_MODEL 一致
```

仅当 NextChat 服务端可经网络访问代理时使用；否则优先使用应用内自定义接口。

## 配置速查

| 字段 | 值 | 说明 |
|---|---|---|
| 接口地址 | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；`default` 为记忆空间 ID — 按 space 修改；**不带尾部 `/v1`** |
| API Key | `sk-mem-...` | Panel 发放的业务用户密钥 |
| 自定义模型 | `PROXY_UPSTREAM_MODEL` 的值（如 `claude-sonnet-4-20250514`） | 手动填写 — 获取模型列表按钮无内容可列 |
| 模型 provider | OpenAI（默认） | 走 OpenAI 兼容路径 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 点 *获取模型列表* 后列表为空 | 预期 — 代理无 `GET /v1/models` 路由；在自定义模型字段填写模型 ID |
| 填了裸主机名却请求了 `https://…` | 客户端对无 scheme 的地址自动前缀 `https://` — 始终填写完整 `http://…` 地址 |
| `401` / "Invalid API Key" | 密钥必须是 Panel 的业务用户密钥（`sk-mem-...`）— 而非 `./.admin-key` 管理员密钥 |
| 空响应 / 上游不匹配 | 模型 ID 与 `PROXY_UPSTREAM_MODEL` 不一致 — 对齐自定义模型条目 |
| 连接被拒 | 代理未在 `:8096` 运行 — 检查 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若前一会话已绑定任务会复用绑定 — 新建话题重新选择 |

## 说明

- **用户本地配置**：自定义接口保存在 NextChat 本地设置 / 部署环境变量中，不存在已提交的配置文件；因此本适配器仅交付文档（与 LobeChat / Open WebUI / LibreChat / aichat / Witsy 适配器一致）。
- **所有对话全覆盖**：使用所配置模型的新话题均获得记忆注入。
- **数据流向**：仅 prompt/completions 经过代理；记忆数据保留在你的本地 SQLite（memory-core），除非另行配置。

## 许可证

MIT，与主仓库一致。
