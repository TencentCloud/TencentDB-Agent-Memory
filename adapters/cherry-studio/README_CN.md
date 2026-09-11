# TencentDB Agent Memory — Cherry Studio 适配器

为 [Cherry Studio](https://github.com/CherryHQ/cherry-studio) 注入持久化团队记忆。本适配器将其 LLM 流量路由至 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入 system prompt
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
Cherry Studio ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                               │
                                               ├─ auth        (校验 sk-mem-... user_key)
                                               ├─ sessionInit (Team/Agent/Task 选择器)
                                               └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Cherry Studio 通过**自定义服务商**功能支持任意 OpenAI 兼容端点：`设置 → 模型服务 → + 添加`，选择 **OpenAI** 服务商类型，填写 **API 密钥**与 **API 地址**（Base URL）并手动添加模型 ID（[官方文档](https://docs.cherryai.com.cn/pre-basic/providers/zi-ding-yi-fu-wu-shang)；文档中 vLLM 示例 —— API 地址 `http://localhost:8000/` —— 展示了 base URL 约定）。将 API 地址指向代理的 `/codebuddy/<spaceId>` 端点即可接入 —— **无需任何代码改动**。

**会话绑定**、**记忆注入**与**自动捕获**全部开箱即用。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动 `start-all.sh` 时打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. Cherry Studio 已安装并运行（Windows / macOS / Linux 桌面端）。

## 配置步骤

### 1. 添加自定义服务商

1. 打开 `设置 → 模型服务`。
2. 点击服务商列表底部的 **+ 添加** 按钮。
3. 在弹窗中填写：
   - **提供商名称**：`TencentDB Agent Memory`
   - **提供商类型**：`OpenAI`
4. 点击**添加**保存，然后打开列表右侧的启用开关。

### 2. 填写连接信息

在服务商详情页：

- **API 密钥**：你的业务用户 key（`sk-mem-...`）
- **API 地址**：`http://127.0.0.1:8096/codebuddy/default`
  （若使用其他空间，将 `default` 替换为你的 memory space ID）

代理同时提供规范路由 `/<spaceId>/v1/chat/completions` 与兜底路由 `/<spaceId>/chat/completions`，因此无论 Cherry Studio 对 OpenAI 类型服务商追加哪种路径形态，上述根端点均可命中。

### 3. 添加模型

在模型管理下点击 **+ 添加**，添加 ID 为 `claude-sonnet-4-20250514` 的模型。

模型 ID **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`；若代理指向其他上游请相应修改。

### 4. 验证

1. 点击 API 密钥旁的**检测**按钮 —— 应报告连接成功。
2. 新建对话，选择 `TencentDB Agent Memory` 服务商与你添加的模型，发送首条消息。代理在对话交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问对话它记得此前会话的哪些内容以确认。

## 配置参考

| 项目 | 取值 | 说明 |
|---|---|---|
| 提供商类型 | `OpenAI` | OpenAI Chat Completions 协议 |
| API 密钥 | `sk-mem-...` | Panel 中的业务用户 key；以 `Authorization: Bearer` 发送 |
| API 地址 | `http://127.0.0.1:8096/codebuddy/default` | 代理端点根地址；`default` 为 memory space ID，按空间修改；无需 `/v1` 后缀（代理双路径均支持） |
| 模型 ID | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |

## 故障排查

| 症状 | 原因 / 修复 |
|---|---|
| 检测失败 / "Invalid API Key" | key 必须是 Panel 中的业务用户 key（`sk-mem-...`）—— 而非 `./.admin-key` 的管理员 key |
| `404` | API 地址必须精确为 `http://<host>:8096/codebuddy/<spaceId>` —— 不带 `/v1`、不带 `/chat/completions`；确认代理运行在 `:8096` |
| "Model Not Found" / 上游不匹配 | 添加的模型 ID 与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐两者 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若此前会话已绑定 task，绑定会被复用 —— 新建 task 以重新选择 |
| 服务商开关无法启用 | 先保存服务商，再切换列表右侧的启用开关 |

## 说明

- **纯文档适配器**：服务商位于你自己的 Cherry Studio 设置中，本适配器除文档外不附带任何文件（与 Chatbox / LobeChat 适配器一致）。
- **全部对话功能均覆盖**：自定义服务商下的常规对话、智能体与话题均使用所配置的端点，均获得记忆注入。
- **数据流向**：仅 prompt/completions 经过代理；记忆数据保留在本地 SQLite（memory-core），除非另行配置。

## 许可证

MIT，与主仓库一致。
