# TencentDB Agent Memory — Void 适配器

为 [Void](https://github.com/voideditor/void) 注入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入系统提示词
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
Void ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                    │
                                    ├─ auth        (校验 sk-mem-... user_key)
                                    ├─ sessionInit (Team/Agent/Task 选择器)
                                    └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Void（开源 AI 编辑器，VS Code 分叉）在 AI 设置中内置 **OpenAI-Compatible** Provider，其 `baseURL` 可指向任意 OpenAI 兼容端点。将其指向代理的 `/codebuddy/<spaceId>` 端点即可接入——**无需任何代码改动**。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 持有业务用户的 `user_key`（`sk-mem-...` 开头）。首次启动时由 `start-all.sh` 打印，或在 Panel（`http://localhost:8125`）创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 已安装 Void——从 [voideditor.com](https://voideditor.com) 下载或基于 [voideditor/void](https://github.com/voideditor/void) 构建。

## 配置步骤

### 1. 将代理注册为 OpenAI-Compatible Provider

1. 打开 **Settings**（左下角齿轮）→ **AI Settings**。
2. 在 Provider 列表中选择 **OpenAI-Compatible**。
3. 填写：
   - **API Key**：业务用户密钥（`sk-mem-...`）
   - **baseURL**：`http://127.0.0.1:8096/codebuddy/default`
     （如使用其他记忆空间，将 `default` 替换为对应 space ID）
   - **不要**追加 `/chat/completions`——Void 会自行拼接请求路径（其 baseURL 字段官方提示为 "do not include /chat/completions"）
4. 在 **Models** 下点击 **Add Model**，输入模型 ID `claude-sonnet-4-20250514`。

### 2. 对齐模型 ID

模型 ID **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`，若代理指向其他上游请相应修改。

### 3. 为 Void 各功能选择该模型

在模型选择下拉中，为 **Chat**（侧边栏，`Ctrl+L` / `Cmd+L`）、**Ctrl+K** 内联编辑与 **Apply** 选择自定义模型。Autocomplete 需要 Fill-in-the-Middle 模型——请保持其独立 Provider。

### 4. 验证

1. 打开聊天侧边栏（`Ctrl+L` / `Cmd+L`），选中自定义模型。
2. 发送首条消息。代理会在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 Void 此前会话记得什么即可确认。

## 配置参考

| 字段（OpenAI-Compatible Provider） | 值 | 说明 |
|---|---|---|
| API Key | `sk-mem-...` | Panel 创建的业务用户密钥；以 `Authorization: Bearer` 发送 |
| baseURL | `http://127.0.0.1:8096/codebuddy/default` | 代理端点；`default` 为记忆空间 ID，按空间替换；不带 `/chat/completions` 后缀 |
| 模型 ID | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| `401` / "Invalid API Key" | 密钥必须是 Panel 的业务用户密钥（`sk-mem-...`）——不是 `./.admin-key` 管理员密钥 |
| `404` | baseURL 拼写错误——必须恰为 `http://<host>:8096/codebuddy/<spaceId>`，不追加任何路径 |
| "Model Not Found" / 上游不匹配 | 模型 ID 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐即可 |
| 连接被拒 | 代理未在 `:8096` 运行——查看 `./start-all.sh` 日志与 `PROXY_UPSTREAM_*` 环境变量 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开任务可重新选择 |

## 说明

- **UI 配置**：Void 将 Provider 设置（含加密后的 API 密钥）保存在自身设置存储中，密钥不会落入工作区文件，因此本适配器仅提供文档（与 Kilo Code / Trae 适配器一致）。
- **Chat / Ctrl+K / Apply 全覆盖**：选为自定义模型的各功能均获得记忆注入；Autocomplete 保持独立的 FIM Provider。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
