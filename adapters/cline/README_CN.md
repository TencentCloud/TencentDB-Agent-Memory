# TencentDB Agent Memory — Cline 适配器

为 [Cline](https://cline.bot)（开源 VS Code AI 智能体）装上团队级持久记忆。本适配器将 Cline 的 LLM 请求路由到 TencentDB Agent Memory 代理，使每个任务自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每一轮对话自动将所绑定 Agent 的 L2/L3 记忆、技能与知识注入系统提示词
- **自动沉淀** — L0 原始对话自动写入 memory-core，供后续提炼

## 工作原理

```
Cline ──(OpenAI Chat Completions 协议)──> Memory Proxy :8096 ──> 上游 LLM
                                             │
                                             ├─ auth        (校验 sk-mem-... user_key)
                                             ├─ sessionInit (Team/Agent/Task 选择器)
                                             └─ injection   (注入 L2/L3 记忆 + 技能 + 知识)
```

Cline 设置面板内置 **"OpenAI Compatible"** provider。代理在 `/codebuddy/<spaceId>` 端点上说 OpenAI Chat Completions 协议，因此 Cline 通过 UI 即可接入——**无需任何文件、无需代码改动**，本适配器为配置指南。

## 前置条件

1. TencentDB Agent Memory 已启动（使用主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获取业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动时 `start-all.sh` 会打印；也可在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. VS Code 已安装 Cline 扩展（见 [cline.bot](https://cline.bot)）。

## 配置步骤

### 1. 配置 provider

打开 VS Code 中的 Cline 面板，点击设置图标（⚙️），填入：

| 字段 | 值 |
|---|---|
| **API Provider** | `OpenAI Compatible` |
| **Base URL** | `http://127.0.0.1:8096/codebuddy/default` |
| **API Key** | 你的 `sk-mem-...` 业务用户密钥 |
| **Model** | `claude-sonnet-4-20250514` |

Base URL 末尾的 `default` 为记忆空间 ID（`x-tdai-service-id`），多空间部署时对应修改。

### 2. 对齐模型 ID

**Model** 字段**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。默认示例使用 `claude-sonnet-4-20250514`。不匹配的模型会被代理以上游错误拒绝。

### 3. 模型配置（建议）

在 Cline 设置的 **Model Configuration** 中：

- **Context Window size**：`200000`（按上游模型对齐）
- **Max Output Tokens**：`16384`
- **Computer Use / 工具调用**：启用（Cline 的文件编辑等 agentic 能力需要）
- **Input/Output price**：保持 0 —— 上游计费不经过 Cline

保存前点击 **Verify** 确认连接。

### 4. 验证记忆

1. 新建一个 Cline 任务并发送第一条消息。代理会在 Cline 面板中渲染会话选择器：选择你的 **Team → Agent → Task**。
2. 从本轮起，所绑定 Agent 的记忆将自动注入。可以让 Cline 回忆此前会话内容进行验证。

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| "Invalid API Key" | 密钥错误 —— 确认使用业务用户密钥（`sk-mem-...`）而非 `./.admin-key` 管理员密钥 |
| "Model Not Found" | Model 字段与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐两者 |
| 连接错误 / `404` | 代理未在 `:8096` 运行 —— 查看 `./start-all.sh` 日志及 `PROXY_UPSTREAM_*` 环境变量；同时检查 Base URL 是否包含空间 ID 路径 |
| Verify 按钮失败 | 同上三类原因 —— Base URL 笔误最常见 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 时自动开启）；若此前任务已绑定会话会复用绑定 —— 新建一个 Cline 任务即可重新选择 |

## 说明

- **UI 配置**：Cline 将 provider 设置存入 VS Code 密钥存储，因此本适配器以指南形式提供——密钥永远不会进入版本库。
- **端点前缀**：复用代理的 OpenAI 兼容端点（`/codebuddy/<spaceId>`）；待上游提供专用前缀后，仅需修改 Base URL。
- **数据流**：只有提示词/补全流量经过代理；记忆数据始终保存在本地 SQLite（memory-core）中，除非你另行配置。
- **版本**：已在 Cline 的 "OpenAI Compatible" provider（见官方文档）与 TencentDB Agent Memory v3（`feat/server_team` 分支，v2.0.0 镜像）上验证。

## 许可证

MIT，与主仓库一致。
