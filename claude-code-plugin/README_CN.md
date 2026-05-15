# TencentDB Agent Memory — Coding Agent 插件

为 [Claude Code](https://claude.com/claude-code) 与 [OpenAI Codex CLI](https://developers.openai.com/codex/cli) 提供长期记忆 + 符号化短期记忆，由 [TencentDB Agent Memory](https://github.com/Tencent/TencentDB-Agent-Memory) 驱动。

插件携带双 manifest（`.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`），共享同一份 `hooks/hooks.json` 与 `skills/`。Claude Code（v2026.4+）与 Codex CLI（v0.117+）实现了同一份 hook 协议，因此一套源码同时服务两个宿主。

[English version](./README.md)

## 能给你什么

- **自动召回**：每次提问前，相关过往记忆自动注入到上下文
- **自动捕获**：每轮对话结束后，L0 落盘、L1/L2/L3 后台抽取
- **手动控制**：通过 slash 技能 `/memory-search`、`/memory-status`、`/memory-clear-session`
- **项目级隔离**：默认按 cwd hash 分区，`react-app` 的记忆不会泄漏到 `golang-svc`
- **Bearer Token 鉴权**：本地 daemon 不裸奔，所有请求需带 token

## 安装

### 前置条件

先全局安装 gateway 运行时（提供 `tdai-memory-gateway` 命令）—— 插件通过 `npx tdai-memory-gateway` 启动 daemon：

```bash
npm install -g @tencentdb-agent-memory/memory-tencentdb
```

该 npm 包含真正的 `TdaiGateway`（SQLite + sqlite-vec + LLM pipeline）。插件本身只是一层薄壳，提供 hook、skill 和 sessionKey 等绑定逻辑，不携带任何重型依赖。

### Claude Code

```bash
/plugin install tdai-memory
```

### Codex CLI

```bash
codex plugin marketplace add <marketplace-url>
# 在 TUI 中启用：/plugin → 切换 tdai-memory
```

（一旦发布到 Codex marketplace，将变为一条命令安装。）

---

不需要改 `~/.claude/settings.json` 或 `~/.codex/config.toml`。第一次启动 session 时，插件通过 `npx tdai-memory-gateway` 在 8421–8430 端口拉起 daemon，并生成随机 Bearer token。状态保存在 `${CLAUDE_PLUGIN_DATA}`。

## 配置

插件读取以下可选环境变量：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `TDAI_SESSION_KEY` | `hash(cwd)` | 覆盖项目级记忆分区 |
| `TDAI_TOKEN_PATH` | 自动生成的 0o600 文件 | daemon 从该文件读取 Bearer token（优于 `TDAI_GATEWAY_TOKEN`，后者会把 token 写进 `/proc/<pid>/environ` 与 `ps -E` 可见的环境块） |
| `TDAI_GATEWAY_TOKEN` | 未设置 | 通过环境变量传 Bearer token（Hermes sidecar 模式的兼容方式） |
| `TDAI_GATEWAY_HOST` | `127.0.0.1` | daemon 绑定地址。非 loopback 值需同时设置 `TDAI_GATEWAY_ALLOW_REMOTE=1`，否则启动被拒，防止误把记忆端口曝露到 LAN。 |
| `TDAI_GATEWAY_ALLOW_REMOTE` | 未设置 | 显式开关，允许 daemon 绑定非 loopback host |
| `TDAI_GATEWAY_CORS_ORIGIN` | 未设置 | 设置时按给定 Origin 启用 CORS；默认不启用，避免跨源页面探测 daemon 端口。 |
| `TDAI_GATEWAY_COMMAND` | `npx` | 覆盖 daemon 启动命令（高级用法；如 `node /path/to/cli.mjs` 用于本地开发） |

大多数用户都不需要设置任何变量。`TDAI_SESSION_KEY=shared-with-other-project` 是最常用的高级用法。

## 数据位置

- `${CLAUDE_PLUGIN_DATA}/state.json` — daemon PID + 端口（tmp+rename 原子写）
- `${CLAUDE_PLUGIN_DATA}/token` — Bearer token（chmod 600，读取时校验 owner uid）
- `${CLAUDE_PLUGIN_DATA}/spawn.lock` — O_CREAT|O_EXCL daemon 启动互斥锁（60s 后视为陈旧）
- `${CLAUDE_PLUGIN_DATA}/cursors/<sessionId>.json` — 每个 cc 会话的 `lastSentIndex`，Stop hook 增量发送依赖
- `${CLAUDE_PLUGIN_DATA}/memory-tdai/` — SQLite + sqlite-vec 数据、场景块、画像快照
- `${CLAUDE_PLUGIN_DATA}/hook.log` — hook 排障日志（gateway-client 请求失败等）
- `${CLAUDE_PLUGIN_DATA}/daemon.log` — daemon stderr/stdout（冷启动 crash 等）

## 工作原理

```
用户输入  → UserPromptSubmit hook → POST /recall   → cc 注入上下文
cc 回复  → Stop hook              → POST /capture  → L0 + L1/L2/L3 流水线
会话退出 → daemon 检测父 cc 退出   → 优雅关闭
```

所有 hook 都是"失败静默"——日志写 `hook.log`，记忆系统永远不在对话的关键路径上。

## 排障

**`/memory-status` 显示 "unreachable"**：
- 看 `${CLAUDE_PLUGIN_DATA}/hook.log`（gateway-client 请求失败）与 `${CLAUDE_PLUGIN_DATA}/daemon.log`（daemon 冷启动 crash）
- 重启 cc 会话——SessionStart hook 会重新探活并 spawn daemon

**多个 cc 终端开同一个项目**：
- 共享一个 daemon。第一个启动的 cc 拉起它，后续 cc 通过 `state.json` 发现并复用。

**记忆召回不准**：
- 直接跑 `/memory-search <topic>` 看存了什么
- L1/L2/L3 抽取是异步的，新对话需要几分钟才能被召回到

## 安全模型

- Daemon 默认仅监听 `127.0.0.1`。非 loopback `TDAI_GATEWAY_HOST` 必须同时设置 `TDAI_GATEWAY_ALLOW_REMOTE=1` 才允许绑定。
- 每个请求都需要 `Authorization: Bearer <token>`。比较使用 `crypto.timingSafeEqual`，scheme 关键字按 RFC 6750 §2.1 大小写不敏感；401 响应携带 `WWW-Authenticate: Bearer realm="tdai-gateway"`。
- Token 在每次 daemon spawn 时新生成，写入 `${CLAUDE_PLUGIN_DATA}/token`（chmod 600），通过 **文件路径** `TDAI_TOKEN_PATH` 传给 daemon 子进程，而不是注入到子进程环境变量——避免 token 出现在 `/proc/<pid>/environ` 与 `ps -E`。daemon 读取 token 时还会校验文件 owner uid 与当前进程一致。
- `memory-search` skill 通过 heredoc 把用户 query 喂到 daemon stdin，而不是作为 shell argv 元素拼接——绕开 cc 当前对 `$ARGUMENTS` 的字面 `replaceAll` 注入面（anthropics/claude-code#16163）。
- Windows 下跳过 0o077 mode 位校验（Node `fs` 在 Win 下返回固定 mode 位会误报），改为依赖 OS 给 token 文件的 NTFS ACL。

## 源码构建

```bash
pnpm install
pnpm build:cc-plugin
pnpm test:cc-plugin
```

## License

MIT — 见 [LICENSE](../LICENSE)。
