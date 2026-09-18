# TencentDB Agent Memory — Chatbox 适配器

为 [Chatbox](https://chatboxai.app/zh_CN) 注入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每段对话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入系统提示词
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
Chatbox ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                        │
                                        ├─ auth        (校验 sk-mem-... user_key)
                                        ├─ sessionInit (Team/Agent/Task 选择器)
                                        └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Chatbox（跨平台桌面/移动 AI 客户端）支持 **OpenAI API Compatible** 类型的自定义 Provider：填写 **API 域名（API Host）** 与 **API 密钥**，Chatbox 会自行拼接接口路径（默认 `/v1/chat/completions`）——见[官方模型配置指南](https://docs.chatboxai.app/zh_CN/guides/providers)。将 API 域名指向代理的 `/codebuddy/<spaceId>` 端点即可接入——**无需任何代码改动**，且默认接口路径恰好命中代理的规范路由。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 持有业务用户的 `user_key`（`sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 已安装 Chatbox——从 [chatboxai.app](https://chatboxai.app/zh_CN) 下载（Windows / macOS / Linux / Android / iOS）。

## 配置步骤

### 1. 将代理注册为自定义 Provider

1. 打开 **设置**（侧边栏齿轮）→ **模型** 选项卡。
2. 在 **模型提供方（Model Provider）** 中点击 **添加**（或直接选择 **OpenAI API Compatible**）。
3. 填写：
   - **API 类型**：`OpenAI API Compatible`
   - **API 密钥**：业务用户密钥（`sk-mem-...`）
   - **API 域名（API Host）**：`http://127.0.0.1:8096/codebuddy/default`
     （如使用其他记忆空间，将 `default` 替换为对应 space ID）
   - **API 路径**：保持默认 `/v1/chat/completions`——Chatbox 自行拼接到域名后，恰好命中代理的规范路由
4. 添加名称为 `claude-sonnet-4-20250514` 的模型。
5. 保存并点击 **检查**——应显示连接成功。

### 2. 对齐模型名

模型名**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`，若代理指向其他上游请相应修改。

### 3. 验证

1. 返回首页，新建对话并选择自定义模型。
2. 发送首条消息。代理会在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 Chatbox 此前对话记得什么即可确认。

## 配置参考

| 字段（自定义 Provider） | 值 | 说明 |
|---|---|---|
| API 类型 | `OpenAI API Compatible` | OpenAI Chat Completions 协议 |
| API 密钥 | `sk-mem-...` | Panel 创建的业务用户密钥；以 `Authorization: Bearer` 发送 |
| API 域名（API Host） | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；`default` 为记忆空间 ID，按空间替换；仅填根地址，不带 `/v1`、不带接口路径 |
| API 路径 | `/v1/chat/completions`（默认） | 由 Chatbox 自动拼接——与代理规范路由一致，无需修改 |
| 模型名 | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| "Invalid API Key" / 检查失败 | 密钥必须是 Panel 的业务用户密钥（`sk-mem-...`）——不是 `./.admin-key` 管理员密钥 |
| `404` | API 域名必须仅为根端点——恰为 `http://<host>:8096/codebuddy/<spaceId>`，不带 `/v1`、不带接口路径 |
| "Model Not Found" / 上游不匹配 | 模型名与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 连接被拒 | 代理未在 `:8096` 运行——查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开对话可重新选择 |

## 说明

- **UI 配置**：Chatbox 将 Provider 档案（含 API 密钥）保存在本地应用存储中，密钥不会落入工作区文件，因此本适配器仅提供文档（与 Open WebUI / LobeChat 适配器一致）。
- **所有对话全覆盖**：使用自定义模型的全部对话均获得记忆注入——共享同一 Provider 配置的桌面与移动端皆然。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
