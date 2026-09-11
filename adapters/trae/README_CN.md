# TencentDB Agent Memory — Trae 适配器

为 [Trae](https://www.trae.cn/) 注入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入系统提示词
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
Trae ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                    │
                                    ├─ auth        (校验 sk-mem-... user_key)
                                    ├─ sessionInit (Team/Agent/Task 选择器)
                                    └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Trae 支持**自定义配置**添加模型，API 格式选 **OpenAI Chat Completions** 并填写自定义请求地址（[官方文档](https://docs.trae.ai/docs/models)）。将请求地址指向代理的 `/codebuddy/<spaceId>` 端点即可接入——**无需任何代码改动**。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 持有业务用户的 `user_key`（`sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 已安装 Trae（字节跳动的 AI IDE）——从 [trae.cn](https://www.trae.cn/) 下载。

## 配置步骤

### 1. 将代理添加为自定义模型

1. 打开 **设置** → **模型**，进入模型管理面板。
2. 点击 **添加模型**。
3. 选择 **自定义配置**。
4. 填写：
   - **API 格式**：`OpenAI Chat Completions`
   - **自定义请求地址**：打开 **完整 URL** 开关，填写完整端点
     `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions`
     （如使用其他记忆空间，将 `default` 替换为对应 space ID）
   - **模型 ID**：`claude-sonnet-4-20250514`
   - **API 密钥**：业务用户密钥（`sk-mem-...`）
   - *（可选）* 展开 **高级配置** 设置展示名称与上下文窗口上限
5. 点击 **添加模型**。Trae 会调用服务商接口校验 API 密钥——校验成功后模型出现在列表中；失败时窗口会展示错误信息与返回日志。

### 2. 对齐模型 ID

模型 ID **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`，若代理指向其他上游请相应修改。

### 3. 验证

1. 在对话框右下角点击当前模型名，选择刚添加的自定义模型。
2. 发送首条消息。代理会在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 Trae 此前会话记得什么即可确认。

## 配置参考

| 字段（添加模型 → 自定义配置） | 值 | 说明 |
|---|---|---|
| API 格式 | `OpenAI Chat Completions` | OpenAI `/v1/chat/completions` 协议 |
| 自定义请求地址（完整 URL 开） | `http://127.0.0.1:8096/codebuddy/default/v1/chat/completions` | 代理端点；`default` 为记忆空间 ID，按空间替换 |
| 模型 ID | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |
| API 密钥 | `sk-mem-...` | Panel 创建的业务用户密钥；以 `Authorization: Bearer` 发送 |

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| "Invalid API Key" / 添加时校验失败 | 密钥必须是 Panel 的业务用户密钥（`sk-mem-...`）——不是 `./.admin-key` 管理员密钥；查看窗口中展示的服务商日志 |
| "Model Not Found" / 上游不匹配 | 模型 ID 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| `404` / 连接被拒 | 完整 URL 拼写错误或代理未在 `:8096` 运行——URL 必须为 `http://<host>:8096/codebuddy/<spaceId>/v1/chat/completions`；查看 `./start-all.sh` 日志 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开任务可重新选择 |

## 说明

- **UI 配置**：Trae 将自定义模型档案保存在自身设置存储中，密钥不会落入工作区文件，因此本适配器仅提供文档（与 Kilo Code / Roo Code 适配器一致）。
- **对话与 Agent 模式全覆盖**：Trae 的聊天、内联补全与 Agent 工作流均使用所选模型，全部获得记忆注入。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
