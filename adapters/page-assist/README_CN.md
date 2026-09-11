# TencentDB Agent Memory — Page Assist 适配器

为 [Page Assist](https://github.com/n4ze3m/page-assist) 装上持久团队记忆。本适配器把扩展的 LLM 流量路由到 TencentDB Agent Memory 代理，每段侧边栏 / Web UI 对话自动获得：

- **会话绑定** —— 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** —— 绑定 Agent 的 L2/L3 记忆、技能与知识在每一轮混入系统提示词
- **自动沉淀** —— L0 原始对话写入 memory-core，供后续蒸馏

## 工作原理

```
Page Assist ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游 LLM
                                             │
                                             ├─ auth        (校验 sk-mem-... user_key)
                                             ├─ sessionInit (Team/Agent/Task 选择器)
                                             └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Page Assist 支持 **OpenAI Compatible API** 端点：在 Settings → **OpenAI Compatible API** 中可添加 **Custom** 自定义 provider，填入自己的 API URL 与 API Key（见[官方 provider 文档](https://github.com/n4ze3m/page-assist/blob/main/docs/providers/openai.md)）。扩展使用 OpenAI 聊天客户端驱动自定义 provider，会在 API URL 后拼接 `/chat/completions`（已核实源码：`src/models/CustomChatOpenAI.ts` 以 provider 的 `baseUrl` 构建客户端）。把该 URL 指向代理的 `/codebuddy/<spaceId>/v1` 端点即可接入——**无需改任何代码**。

**会话绑定**（首条消息触发 Team → Agent → Task 选择器）、**记忆注入**（绑定 Agent 的 L2/L3 记忆、技能与知识每轮混入系统提示词）与**自动沉淀**（L0 原始对话写入 memory-core）全部开箱即用。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 浏览器已安装 [Page Assist](https://github.com/n4ze3m/page-assist) 扩展（Chrome / Edge / Brave / Firefox）。

## 配置步骤

### 1. 把代理添加为自定义 provider

1. 点击浏览器工具栏的 Page Assist 图标，再点击 **Settings** 图标。
2. 进入 **OpenAI Compatible API** 标签页。
3. 点击 **Add Provider**，在下拉框中选择 **Custom**。
4. 填写：
   - **API URL**：`http://127.0.0.1:8096/codebuddy/default/v1` —— 若使用其他记忆空间，把 `default` 换成对应 spaceId。**保留末尾 `/v1`**：扩展的 OpenAI 客户端会在 API URL 后追加 `/chat/completions`，正好落在代理的 `/codebuddy/<spaceId>/v1/chat/completions` 路由上。
   - **API Key**：业务用户密钥（`sk-mem-...`）。
5. 点击 **Save**。

### 2. 添加模型

Custom provider 不会自动发现模型（仅 Ollama / LM Studio / Llamafile 预置项会自动拉取），需在同一标签页手动添加：

- **Model ID**：代理的 `PROXY_UPSTREAM_MODEL` 值（如 `claude-sonnet-4-20250514`）。**必须与**代理上游模型一致，否则代理以上游不匹配为由拒绝。

### 3. 验证

1. 打开 Page Assist 侧边栏（或 Web UI），选择代理模型。
2. 发送第一条消息。代理在聊天交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从这一轮起，绑定 Agent 的记忆自动注入。向 Page Assist 询问之前对话记得什么即可确认。

## 配置速查

| 字段 | 值 | 说明 |
|---|---|---|
| API URL | `http://127.0.0.1:8096/codebuddy/default/v1` | 代理端点；`default` 为记忆空间 ID，按空间替换；**保留**末尾 `/v1` |
| API Key | `sk-mem-...` | Panel 创建的业务用户密钥；以 `Authorization: Bearer` 发送 |
| Model ID | `PROXY_UPSTREAM_MODEL` 的值（如 `claude-sonnet-4-20250514`） | 必须与代理上游模型一致 |

## 故障排查

| 症状 | 原因 / 解决 |
|---|---|
| `401` / "Invalid API Key" | 必须使用 Panel 的业务用户密钥（`sk-mem-...`），不能用 `./.admin-key` 的管理员密钥 |
| 请求被浏览器拦截 | provider 设置中有 **Fix CORS** 选项（扩展默认遵循浏览器 CORS 规则）；侧边栏无法访问 `127.0.0.1:8096` 时开启它 |
| AI 回复为空 / 上游不匹配 | Model ID 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 模型列表为空 | Custom provider 的预期行为——手动添加 model ID（仅 Ollama / LM Studio / Llamafile 预置项自动拉取） |
| `404` / 连接被拒 | 代理未在 `:8096` 运行——检查 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 会话选择器未出现 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动设置）；若前一会话已绑定任务，绑定会被复用——新开聊天即可重新选择 |

## 说明

- **配置仅存于本地**：provider 与密钥只保存在扩展本地存储中，不进入任何提交文件；因此本适配器只包含文档（与 LobeChat / Open WebUI / LibreChat 适配器一致）。
- **全部聊天经过代理**：所有使用该配置模型的侧边栏聊天与 Web UI 对话都会获得记忆注入。
- **数据流**：仅提示词/补全流经代理；记忆数据保留在本地 SQLite（memory-core）中，除非你另行配置。

## 许可证

MIT，与主仓库一致。
