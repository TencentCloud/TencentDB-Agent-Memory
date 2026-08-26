# TencentDB Agent Memory — Ellama 适配器

为 [Ellama](https://github.com/s-kostyaev/ellama)（Emacs LLM 助手）注入持久化团队记忆。本适配器将其 LLM 流量路由至 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、技能与知识融入 system prompt
- **自动捕获** — L0 原始对话持久化到 memory-core，供后续蒸馏

## 工作原理

```
Ellama ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> Upstream LLM
                                         │
                                         ├─ auth        (校验 sk-mem-... user_key)
                                         ├─ sessionInit (Team/Agent/Task 选择器)
                                         └─ injection   (L2/L3 记忆 + 技能 + 知识)
```

Ellama 通过 [llm](https://elpa.gnu.org/packages/llm.html) 包访问模型，"OpenAI-compatible" 是其内置 provider 选项之一（[Ellama README](https://github.com/s-kostyaev/ellama)；`M-x ellama-select-model` 直接列出该项）。`llm-openai-compatible` provider 接受 `:url` —— 即**不含** `chat/completions` 命令部分、以斜杠结尾的 base URL（[llm 文档 §3.2](https://elpa.gnu.org/packages/llm.html)）—— 以及 `:chat-model` 与 `:key`（继承自 `llm-openai`，以 `Authorization: Bearer` 发送；已在 [llm-openai.el 源码](https://github.com/ahyatt/llm) 中核实）。将 `:url` 指向代理的 `/codebuddy/<spaceId>/v1/` base 即可接入 —— **无需任何代码改动**。

## 前置条件

1. TencentDB Agent Memory 已运行（主仓库 README 的一键栈）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 你持有业务用户的 `user_key`（以 `sk-mem-...` 开头）。首次启动 `start-all.sh` 时打印，或在 Panel（`http://localhost:8125`）中创建。不建议使用 `./.admin-key` 中的原始管理员密钥。

3. 已安装 Ellama（`M-x package-install RET ellama RET`），它会一并拉取 `llm` 包。

## 配置步骤

### 1. 导出 API key

```bash
export TDB_MEM_USER_KEY=sk-mem-xxxxxxxx   # 你的业务用户 key
```

Emacs 必须继承该变量 —— 从该 shell 启动，或使用 `exec-path-from-shell`。也可以改用 `auth-source` 存 key（见"说明"），替代 `getenv`。

### 2. 配置 provider

在你的 Emacs 配置中加入：

```elisp
(require 'llm-openai-compatible)

(setopt ellama-provider
        (make-llm-openai-compatible
         :url "http://127.0.0.1:8096/codebuddy/default/v1/"
         :chat-model "claude-sonnet-4-20250514"
         :key (getenv "TDB_MEM_USER_KEY")))
```

若使用其他空间，将 `default` 替换为你的 memory space ID。

**注意**：`:url` 是**以斜杠结尾的 base** —— `llm` 自行追加 `chat/completions`，与其文档示例 `https://api.openai.com/v1/` 一致（llm 文档 §3.2）。请勿在 URL 中添加 `chat/completions`。

### 3. 对齐模型名

`:chat-model` 值**必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（在 `deploy/global-images/.env` 中设置）。示例使用 `claude-sonnet-4-20250514`；若代理指向其他上游请相应修改。

### 4. 验证

1. 重启 Emacs / 重新求值配置，在任意 buffer 中运行 `M-x ellama-chat`。
2. 发送首条 prompt。代理在请求交互中触发会话选择器：选择你的 **Team → Agent → Task**。
3. 从本轮起，绑定 Agent 的记忆自动注入。询问 Ellama 它记得此前会话的哪些内容以确认。

## 配置参考

| 项目 | 取值 | 说明 |
|---|---|---|
| Provider 构造器 | `make-llm-openai-compatible` | 来自 `llm` 包（`(require 'llm-openai-compatible)`） |
| `:url` | `http://127.0.0.1:8096/codebuddy/default/v1/` | **以斜杠结尾**的 base URL；`llm` 追加 `chat/completions`；`default` 为 memory space ID，按空间修改 |
| `:chat-model` | `claude-sonnet-4-20250514` | 必须等于 `PROXY_UPSTREAM_MODEL`，否则代理以上游不匹配拒绝 |
| `:key` | `(getenv "TDB_MEM_USER_KEY")` | `sk-mem-...` 业务用户 key；以 `Authorization: Bearer` 发送 |
| `ellama-provider` | 上述 provider | 所有 Ellama 命令使用它；更多命名 provider 可放入 `ellama-providers` |

## 故障排查

| 症状 | 原因 / 修复 |
|---|---|
| `404` / 端点错误 | `:url` 必须是以斜杠结尾的 base —— `http://<host>:8096/codebuddy/<spaceId>/v1/` —— 不带 `chat/completions` 后缀、不缺 `/v1` |
| "Invalid API Key" / 鉴权失败 | key 必须是 Panel 中的业务用户 key（`sk-mem-...`）—— 而非 `./.admin-key` 的管理员 key；确认 Emacs 启动环境已导出 `TDB_MEM_USER_KEY` |
| "Model Not Found" / 上游不匹配 | `:chat-model` 与 `PROXY_UPSTREAM_MODEL` 不一致 —— 对齐两者 |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若此前会话已绑定 task，绑定会被复用 —— 新建 task 以重新选择 |
| key 解析为 `nil` | GUI Emacs 不继承 shell 导出 —— 从导出变量的 shell 启动 Emacs，或使用 `exec-path-from-shell` / `auth-source` |

## 说明

- **纯文档适配器**：provider 位于你自己的 Emacs 配置中，key 不会落入版本控制文件；本适配器仅包含文档（与 gptel 适配器一致）。
- **交互式切换仍然可用**：`M-x ellama-select-model` 将 OpenAI-compatible 列为内置选项并支持 URL 编辑，无需改动 `ellama-provider` 也能以 transient provider 指向代理。
- **auth-source 替代方案**：在 `~/.authinfo.gpg` 中存入形如 `machine 127.0.0.1 port 8096 login ellama password sk-mem-...` 的条目，用 `(auth-source-search :host "127.0.0.1" :port "8096" :max 1)` 读取，替代 `getenv`。
- **数据流向**：仅 prompt/completions 经过代理；记忆数据保留在本地 SQLite（memory-core），除非另行配置。

## 许可证

MIT，与主仓库一致。
