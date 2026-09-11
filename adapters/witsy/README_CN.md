# TencentDB Agent Memory — Witsy 适配器

为 [Witsy](https://github.com/Kochava-Studios/witsy) 装上持久团队记忆。Witsy 是一款桌面 AI 助手 / 通用 MCP 客户端（Windows、macOS、Linux），覆盖聊天、Agent、命令与 MCP 服务器。本适配器把其 LLM 流量路由到 TencentDB Agent Memory 代理，每次聊天、Agent 运行与命令自动获得：

- **会话绑定** —— 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** —— 绑定 Agent 的 L2/L3 记忆、技能与知识在每一轮混入系统提示词
- **自动沉淀** —— L0 原始对话写入 memory-core，供后续蒸馏

## 工作原理

```
Witsy ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游 LLM
                                        │
                                        ├─ auth        (校验 sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task 选择器)
                                        └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Witsy 支持 **自定义 LLM 引擎**，可选 OpenAI 或 Azure API 规范（Create Engine 对话框）。OpenAI 规范引擎会用引擎的 `apiKey` 与 `baseURL` 实例化官方 OpenAI SDK 客户端（已核实源码：`src/renderer/services/llms/base.ts` —— `igniteCustomEngine` → `new llm.OpenAI({ apiKey, baseURL })`，经由 [multi-llm-ts](https://github.com/nbonamy/multi-llm-ts) provider，调用 `client.chat.completions.create()`，即 `POST <baseURL>/chat/completions`）。把 `baseURL` 指向代理的 `/codebuddy/<spaceId>/v1` 端点即可接入——**无需改任何代码**。

聊天模型输入框为自由文本组合框：手动输入的模型 id 会被保存进引擎模型列表（已核实源码：`src/renderer/settings/SettingsCustomLLM.vue` —— `save()` 在模型不在列表时自动加入），因此不依赖任何模型列表端点。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. Witsy 已安装（从 [releases](https://github.com/Kochava-Studios/witsy/releases) 获取 —— Windows 安装包、macOS DMG 或 AppImage）并至少启动过一次。

## 配置步骤

### 1. 创建指向代理的自定义引擎

在 Witsy 中新建自定义引擎（Create Engine 对话框 —— 可从模型选择器 / 引擎设置进入）：

- **API 规范（API specification）** —— `OpenAI`
- **名称（Name）** —— 任意，例如 `TencentDB Memory`
- **API Base URL** —— `http://127.0.0.1:8096/codebuddy/default/v1`
- **API Key** —— 你的 `sk-mem-...` 业务用户密钥

如使用其他记忆空间，把 `default` 替换为你的 spaceId。保留结尾的 `/v1`：客户端会在 base URL 后拼接 `/chat/completions`，正好落在代理的 `/codebuddy/<spaceId>/v1/chat/completions` 路由上。

### 2. 手动设置聊天模型

输入 API Key 后 Witsy 会尝试拉取模型列表（`GET <baseURL>/models`），但代理不提供模型列表端点 —— 列表会保持为空。这是预期行为：聊天模型输入框为自由文本组合框，在引擎设置中**手动输入模型 id** 即可（Chat Model 一栏），例如 `claude-sonnet-4-20250514`。输入值会被自动保存进引擎模型列表。

模型 id **必须与**代理的 `PROXY_UPSTREAM_MODEL` 值一致，否则代理会以上游不匹配拒绝请求。

### 3. 对话验证

1. 在聊天模型选择器中选中该引擎与模型。
2. 发送第一条消息。代理在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。向 Witsy 询问它记得之前对话的哪些内容即可确认。

## 配置参考

| 字段 | 值 | 说明 |
|---|---|---|
| API 规范 | `OpenAI` | 不使用 Azure 变体 |
| 名称 | `TencentDB Memory`（任意） | 显示在引擎/模型选择器中 |
| API Base URL | `http://127.0.0.1:8096/codebuddy/default/v1` | 代理端点；`default` 为记忆空间 ID，按空间替换；保留结尾 `/v1` |
| API Key | `sk-mem-...` | Panel 中的业务用户密钥 |
| Chat Model | `PROXY_UPSTREAM_MODEL` 的值（如 `claude-sonnet-4-20250514`） | 手动输入 —— 设置页会持久化手动输入的值 |

## 故障排查

| 症状 | 原因 / 解决 |
|---|---|
| 输入 Key 后模型列表始终为空 | 预期行为 —— 代理无 `GET /v1/models` 路由；在 Chat Model 一栏手动输入模型 id |
| `401` / "Invalid API Key" | 必须使用 Panel 中业务用户的 `sk-mem-...` 密钥 —— 不是 `./.admin-key` 的管理员密钥 |
| 空响应 / 上游不匹配 | 模型 id 与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐 Chat Model 条目 |
| 连接被拒 | 代理未在 `:8096` 运行 —— 查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 无会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若此前会话已绑定任务，绑定会被复用 —— 新开一个聊天即可重新选择 |

## 说明

- **用户本地配置**：引擎只保存在 Witsy 本地设置中，不涉及任何提交文件；本适配器因此仅含文档（与 LobeChat / Open WebUI / LibreChat / aichat 适配器相同）。
- **全部界面生效**：聊天、Agent、命令及一切使用该引擎模型的界面都会获得记忆注入。
- **数据流**：仅提示词/补全经由代理；记忆数据保留在本地 SQLite（memory-core），除非你另行配置。

## 许可证

MIT，与主仓库一致。
