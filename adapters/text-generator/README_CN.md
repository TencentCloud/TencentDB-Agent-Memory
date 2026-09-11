# TencentDB Agent Memory — Text Generator 适配器

为 [Text Generator](https://github.com/nhaouari/obsidian-textgenerator-plugin)（Obsidian AI 文本生成插件）装上持久团队记忆。本适配器把其 LLM 流量路由到 TencentDB Agent Memory 代理，每次生成自动获得：

- **会话绑定** —— 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** —— 绑定 Agent 的 L2/L3 记忆、技能与知识在每一轮混入系统提示词
- **自动沉淀** —— L0 原始对话写入 memory-core，供后续蒸馏

## 工作原理

```
Text Generator ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游 LLM
                                                 │
                                                 ├─ auth        (校验 sk-mem-... user_key)
                                                 ├─ sessionInit (Team/Agent/Task 选择器)
                                                 └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Text Generator 的 **Custom** LLM provider 默认即是一个 OpenAI chat-completions 请求：endpoint 为完整 URL（默认 `https://api.openai.com/v1/chat/completions`），API Key 以 `Authorization: Bearer` 注入，请求体携带模型名（已核实源码：`src/LLMProviders/custom/base.tsx` + `custom.tsx`——endpoint、header 模板与 body 模板均为可编辑字段）。把 endpoint 指向代理的 `/codebuddy/<spaceId>/v1/chat/completions` 路由即可接入——**无需改任何代码**。

**会话绑定**（首条消息触发 Team → Agent → Task 选择器）、**记忆注入**（绑定 Agent 的 L2/L3 记忆、技能与知识每轮混入系统提示词）与**自动沉淀**（L0 原始对话写入 memory-core）全部开箱即用。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. Vault 中已安装 [Text Generator](https://github.com/nhaouari/obsidian-textgenerator-plugin) 插件（第三方插件 → 浏览 → "Text Generator"）。

## 配置步骤

### 1. 配置 Custom provider

在 Obsidian 中打开 **Text Generator → Settings → Providers**，添加（或编辑）一个 **Custom** 类型 provider，设置：

- **Endpoint**：`http://127.0.0.1:8096/codebuddy/default/v1/chat/completions` —— 若使用其他记忆空间，把 `default` 换成对应 spaceId。这是**完整**请求 URL：Text Generator 的 custom provider 接收的就是完整的 chat-completions 端点，与其 OpenAI 默认值形式一致。
- **API Key**：业务用户密钥（`sk-mem-...`）——经默认 header 模板以 `Authorization: Bearer {{api_key}}` 注入。
- **Model**：代理的 `PROXY_UPSTREAM_MODEL` 值（如 `claude-sonnet-4-20250514`）。**必须与**代理上游模型一致，否则代理以上游不匹配为由拒绝。

默认 header/body 模板无需改动——它们产出的就是标准 OpenAI chat-completions 请求。

### 2. 验证

1. 打开一篇笔记，在 Custom provider 生效下执行任一 Text Generator 命令（如 *Generate & Insert*）。
2. 代理在聊天交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从这一轮起，绑定 Agent 的记忆自动注入。生成一段依赖此前对话内容的结果即可确认。

## 配置速查

| 字段 | 值 | 说明 |
|---|---|---|
| Endpoint | `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions` | **完整**请求 URL；`default` 为记忆空间 ID，按空间替换 |
| API Key | `sk-mem-...` | Panel 创建的业务用户密钥；经 header 模板以 `Authorization: Bearer` 注入 |
| Model | `PROXY_UPSTREAM_MODEL` 的值（如 `claude-sonnet-4-20250514`） | 必须与代理上游模型一致；纯文本字段，无需模型列表端点 |

## 故障排查

| 症状 | 原因 / 解决 |
|---|---|
| `401` / "Invalid API Key" | 必须使用 Panel 的业务用户密钥（`sk-mem-...`），不能用 `./.admin-key` 的管理员密钥 |
| "Network request failed — this is usually a CORS error" | Obsidian 渲染进程遵循浏览器 CORS 规则——在 provider 设置中开启 **CORS Bypass** 选项（插件自带旁路代理） |
| AI 回复为空 / 上游不匹配 | Model 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 每次请求都 `404` | endpoint 必须是含 `/v1/chat/completions` 的**完整** URL；只填主机或 base URL 会 404 |
| 连接被拒 | 代理未在 `:8096` 运行——检查 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 会话选择器未出现 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动设置）；若前一会话已绑定任务，绑定会被复用——新开聊天即可重新选择 |

## 说明

- **配置仅存于本地**：endpoint 与密钥只保存在插件设置中，不进入任何提交文件；因此本适配器只包含文档（与 LobeChat / Open WebUI / Obsidian Copilot 适配器一致）。
- **全部生成经过代理**：所有使用 Custom provider 的 Text Generator 模板与命令都会获得记忆注入。
- **数据流**：仅提示词/补全流经代理；记忆数据保留在本地 SQLite（memory-core）中，除非你另行配置。

## 许可证

MIT，与主仓库一致。
