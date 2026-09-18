# TencentDB Agent Memory — Obsidian Copilot 适配器

为 [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) 装上持久团队记忆。本适配器把插件的 LLM 流量路由到 TencentDB Agent Memory 代理，每段对话自动获得：

- **会话绑定** —— 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** —— 绑定 Agent 的 L2/L3 记忆、技能与知识在每一轮混入系统提示词
- **自动沉淀** —— L0 原始对话写入 memory-core，供后续蒸馏

## 工作原理

```
Obsidian Copilot ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游 LLM
                                                 │
                                                 ├─ auth        (校验 sk-mem-... user_key)
                                                 ├─ sessionInit (Team/Agent/Task 选择器)
                                                 └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Obsidian Copilot 的 **BYOK**（自带密钥）设置支持添加**自定义 provider**，可对接任意 OpenAI 兼容端点——插件使用通用 OpenAI 聊天客户端，会在所配置的 Base URL 后拼接 `/chat/completions`（见[官方 LLM Providers 文档](https://github.com/logancyang/obsidian-copilot/blob/master/docs/llm-providers.md)）。把 Base URL 指向代理的 `/codebuddy/<spaceId>/v1` 端点即可接入——**无需改任何代码**。

**会话绑定**（首条消息触发 Team → Agent → Task 选择器）、**记忆注入**（绑定 Agent 的 L2/L3 记忆、技能与知识每轮混入系统提示词）与**自动沉淀**（L0 原始对话写入 memory-core）全部开箱即用。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. Vault 中已安装 [Obsidian Copilot](https://github.com/logancyang/obsidian-copilot) 插件（第三方插件 → 浏览 → "Copilot"）。

## 配置步骤

### 1. 把代理添加为自定义 provider

1. 打开 Obsidian → **Settings → Copilot → BYOK**。
2. 点击 **Add a provider**，选择 **Add a custom provider**。
3. 填写：
   - **Base URL**：`http://127.0.0.1:8096/codebuddy/default/v1` —— 若使用其他记忆空间，把 `default` 换成对应 spaceId。**保留末尾 `/v1`**：插件的 OpenAI 客户端会在 Base URL 后追加 `/chat/completions`，正好落在代理的 `/codebuddy/<spaceId>/v1/chat/completions` 路由上。
   - **API key**：业务用户密钥（`sk-mem-...`）。
4. 模型处直接输入代理的 `PROXY_UPSTREAM_MODEL` 值（如 `claude-sonnet-4-20250514`)作为确切 model ID。模型发现会请求 `<Base URL>/models`；若你的代理部署未提供模型列表端点，请直接手填 model ID，不要依赖发现列表。
5. 点击 **Test**，再点 **Save**。

### 2. 为聊天启用该模型

新模型默认对 Quick Chat 启用；在 **Settings → Copilot → Basic → Agents → Quick Chat** 中确认代理模型已出现，常用的话可设为 **Default model**。

### 3. 验证

1. 打开 Copilot 聊天面板，选择代理模型，发送第一条消息。
2. 代理在聊天交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从这一轮起，绑定 Agent 的记忆自动注入。向 Copilot 询问之前对话记得什么即可确认。

## 配置速查

| 字段 | 值 | 说明 |
|---|---|---|
| Base URL | `http://127.0.0.1:8096/codebuddy/default/v1` | 代理端点；`default` 为记忆空间 ID，按空间替换；**保留**末尾 `/v1` |
| API key | `sk-mem-...` | Panel 创建的业务用户密钥；以 `Authorization: Bearer` 发送 |
| Model ID | `PROXY_UPSTREAM_MODEL` 的值（如 `claude-sonnet-4-20250514`） | 必须与代理上游模型一致，否则代理以上游不匹配为由拒绝 |

## 故障排查

| 症状 | 原因 / 解决 |
|---|---|
| `401` / "Invalid API Key" | 必须使用 Panel 的业务用户密钥（`sk-mem-...`），不能用 `./.admin-key` 的管理员密钥 |
| Test 成功但 Quick Chat 发不出消息 | Obsidian 渲染进程遵循浏览器 CORS 规则——编辑该 provider 并开启 **Enable CORS**（响应将整体返回而非逐 token 流式） |
| 模型发现为空 | 手动输入确切 model ID——发现依赖 `/models` 列表端点，而代理并不要求实现它 |
| AI 回复为空 / 上游不匹配 | 模型名与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| `404` / 连接被拒 | 代理未在 `:8096` 运行——检查 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 会话选择器未出现 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动设置）；若前一会话已绑定任务，绑定会被复用——新开聊天即可重新选择 |

## 说明

- **配置仅存于本地**：provider 与密钥只保存在你 Obsidian 插件设置（vault 的 `data.json`）中，不进入任何提交文件；因此本适配器只包含文档（与 LobeChat / Open WebUI / LibreChat 适配器一致）。
- **全部聊天经过代理**：所有使用该配置模型的聊天（含 agent 功能）都会获得记忆注入。
- **数据流**：仅提示词/补全流经代理；记忆数据保留在本地 SQLite（memory-core）中，除非你另行配置。

## 许可证

MIT，与主仓库一致。
