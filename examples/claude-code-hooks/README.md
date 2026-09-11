# Claude Code hooks — TencentDB Agent Memory for subscription-auth users

> **适用人群**：Claude Code 会话通过 **订阅（OAuth）** 认证的用户。

官方集成通过把 `ANTHROPIC_BASE_URL` 重定向到 memory-proxy 工作，但这会**破坏订阅鉴权**——OAuth 会话无法被指向代理。本示例用两个轻量 shell hooks 直连 Memory Gateway 的 v2 API，**对话仍然走订阅，记忆照常沉淀**。

工作原理与 API-key 代理路径一致（已验证 L0→L1 抽取正常）：

| Hook | 时机 | 作用 |
|------|------|------|
| `stop-hook.sh` | 每轮对话结束（`Stop`） | 从 session transcript 提取最后 user/assistant 一轮，`POST /v2/conversation/add` 写入 L0 |
| `session-start-hook.sh` | 会话开始（`SessionStart`） | `POST /v2/core/read` + `/v2/scenario/ls`，把 L3 画像与场景索引以 `<user-profile>` / `<known-scenes>` 注入会话上下文 |

两个脚本都 **fail-silent**：写失败、网关不可达、`curl --max-time 4` 超时都不会阻塞或报错 Claude Code。

## 1. 配置环境变量

在 `~/.zshrc` / `~/.bashrc`（或 Claude Code 的 env 配置）里设置：

```bash
export TD_MEMORY_URL="http://127.0.0.1:8420"   # Memory Gateway 地址
export TD_MEMORY_KEY="sk-mem-xxxxxxxx..."       # 业务用户 key（Bearer）
# 可选 v2 isolation（默认本地部署可不设）：
# export TD_MEMORY_TEAM_ID="default"
# export TD_MEMORY_AGENT_ID="default"
# export TD_MEMORY_USER_ID="default"
```

## 2. 注册 hooks

把两个 hook 写入 Claude Code 的 `settings.json`（用户级 `~/.claude/settings.json` 或项目级 `.claude/settings.json`）：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /absolute/path/to/examples/claude-code-hooks/stop-hook.sh"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /absolute/path/to/examples/claude-code-hooks/session-start-hook.sh"
          }
        ]
      }
    ]
  }
}
```

> `command` 用**绝对路径**。hook 脚本默认可执行，也可以不加 `bash` 前缀直接写路径。

## 3. 验证

- **写记忆**：跑一轮对话后，检查 Gateway 是否收到 L0 写入：
  ```bash
  # 应返回刚写入的会话消息数
  curl -sS -X POST "$TD_MEMORY_URL/v2/conversation/query" \
    -H "Authorization: Bearer $TD_MEMORY_KEY" \
    -H "Content-Type: application/json" \
    -d '{"session_id":"<session>","limit":5}'
  ```
- **注入画像**：开一个新会话，SessionStart hook 会把 `<user-profile>` 和 `<known-scenes>` 块注入上下文；若无画像/场景则不输出。
- 想临时看 hook 是否触发，可在脚本里加 `echo "[tdai] stop-hook fired" >> /tmp/tdai-hooks.log`。

## 参考

- v2 API 文档：`MemoryCore` 仓库根 README 的 API surface 一节（`/v2/conversation/*`、`/v2/core/*`、`/v2/scenario/*`）
- 相关 issue：[#715](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/715)
