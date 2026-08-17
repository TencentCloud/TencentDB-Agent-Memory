# TencentDB Agent Memory — gptel 适配器

为 [gptel](https://github.com/karthink/gptel) 接入持久化团队记忆。本适配器将其 LLM 流量路由到 TencentDB Agent Memory 代理，每个会话自动获得：

- **会话绑定** — 首条消息触发 Team → Agent → Task 交互式选择器
- **记忆注入** — 每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词
- **自动捕获** — L0 原始对话落盘 memory-core，供后续蒸馏

## 工作原理

```
gptel ──(OpenAI Chat Completions)──> Memory Proxy :8096 ──> 上游大模型
                                       │
                                       ├─ auth        (校验 sk-mem-... user_key)
                                       ├─ sessionInit (Team/Agent/Task 选择器)
                                       └─ injection   (L2/L3 记忆 + skills + knowledge 注入)
```

[gptel](https://github.com/karthink/gptel)（Emacs 的 LLM 客户端）通过 `gptel-make-openai` 注册任意 OpenAI 兼容服务为后端（[官方 README](https://github.com/karthink/gptel#readme)）。将其 `:host`/`:endpoint` 指向代理的 `/codebuddy/<spaceId>` 端点即可接入，**无需改动代码**。

**会话绑定**（首条消息触发 Team → Agent → Task 交互式选择）、**记忆注入**（每轮对话将绑定 Agent 的 L2/L3 记忆、skills 与 knowledge 混入系统提示词）、**自动捕获**（L0 原始对话落盘 memory-core）全部开箱即用，无需改动任何代码。

## 前置条件

1. TencentDB Agent Memory 已启动（主仓库 README 的一键部署）：

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

2. 已获得业务用户的 `user_key`（`sk-mem-...` 开头），首次启动时由 `start-all.sh` 打印，或在面板 `http://localhost:8125` 中创建。不建议直接使用 `./.admin-key` 中的管理员密钥。

3. 已安装 gptel（`M-x package-install RET gptel RET`，见 [gptel README](https://github.com/karthink/gptel#installation)）。

## 配置步骤

### 1. 将代理注册为 gptel 后端

将以下配置加入 Emacs 配置（本目录 `gptel-tdb.el` 为可直接 load 的版本）：

```elisp
(use-package gptel
  :config
  (setq gptel-model 'claude-sonnet-4-20250514
        gptel-backend (gptel-make-openai "TencentDB Agent Memory"
                        :protocol "http"
                        :host "127.0.0.1:8096"
                        :endpoint "/codebuddy/default/chat/completions"
                        :stream t
                        :key (lambda () (getenv "TDB_MEM_USER_KEY"))
                        :models '(claude-sonnet-4-20250514))))
```

密钥处理二选一，均避免明文进入版本库：

- **环境变量**：`:key (lambda () (getenv "TDB_MEM_USER_KEY"))`，并在 shell 中 `export TDB_MEM_USER_KEY=sk-mem-...`（Emacs 需继承该环境——从该 shell 启动，或使用 `exec-path-from-shell`）；
- **auth-source**：将 key 存入 `~/.authinfo.gpg`（host `127.0.0.1`、port `8096`），`:key` 改为从 auth-source 读取的函数。

### 2. 对齐模型名

模型 symbol **必须与代理的 `PROXY_UPSTREAM_MODEL` 一致**（配置于 `deploy/global-images/.env`）。示例使用 `claude-sonnet-4-20250514`，如上游不同请同步修改 `gptel-model` 与 `:models` 列表。

### 3. 验证

1. 重启 Emacs / 重新求值配置，在任意 buffer 执行 `M-x gptel-send`（或在 gptel 会话 buffer 中 `C-c RET`）。
2. 发送首条提示词，代理会在请求交互中触发会话选择器：依次选择 **Team → Agent → Task**。
3. 之后每轮自动注入绑定 Agent 的记忆。可让 gptel 复述之前会话的记忆以确认生效。

## 配置参考

| 配置项 | 值 | 说明 |
|---|---|---|
| 后端构造器 | `gptel-make-openai` | gptel 的通用 OpenAI 兼容后端 |
| `:protocol` | `"http"` | 本地代理使用明文 HTTP |
| `:host` | `"127.0.0.1:8096"` | 代理主机与端口，不含 scheme |
| `:endpoint` | `/codebuddy/default/chat/completions` | `default` 为记忆空间 ID，可按空间替换 |
| `:key` | 函数 | 从环境变量或 auth-source 读取 `sk-mem-...` 业务用户 key，以 `Authorization: Bearer` 发送 |
| `:models` / `gptel-model` | `claude-sonnet-4-20250514` | 必须与 `PROXY_UPSTREAM_MODEL` 一致，否则代理报上游模型不匹配 |

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 代理返回 `401` | 必须使用面板创建的业务用户 key（`sk-mem-...`），不能用 `./.admin-key` 的管理员 key；检查 `:key` 函数是否确实返回该值 |
| `404` / 连接被拒 | 代理未在 `:8096` 运行，或 `:endpoint` 有误——路径必须包含完整的 `/codebuddy/<spaceId>/chat/completions` |
| 环境变量方式取到 nil | Emacs 不是从导出 `TDB_MEM_USER_KEY` 的 shell 启动的——改用 auth-source，或从该 shell 重新启动 Emacs |
| 模型不匹配报错 | 模型 symbol 与 `PROXY_UPSTREAM_MODEL` 不一致——对齐 `gptel-model` 与 `:models` |
| 未出现会话选择器 | 需要 `PROXY_ENABLE_SESSION_INIT=1`（`PROXY_FULL_STACK=1` 会自动设置）；若会话已绑定过任务会复用绑定——新开 gptel 对话可重新选择 |

## 说明

- **任意 buffer 即会话**：gptel 对话存在于普通 Emacs buffer 中；持续使用的每个对话保留其绑定的任务并不断积累记忆。
- **Org-mode 友好**：响应以 markdown/org 文本插入，记忆注入的回答便于归档与检索。
- **数据流**：仅提示词/补全流量经过代理；记忆数据默认保存在本地 SQLite（memory-core）。

## 许可证

MIT，与主仓库一致。
