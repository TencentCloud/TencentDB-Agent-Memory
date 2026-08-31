# 在 Claude Code 中使用 TencentDB Agent Memory

Claude Code 使用两种接入方式，底层复用同一个 Gateway HTTP client。stdio MCP server 向模型暴露工具；生命周期 Hook 则直接调用 `MemoryTools`，确定性执行自动 recall、capture 和 session flush。Hook 请求不会经过 stdio MCP server。

| Claude Code 事件 | MCP 操作 | 行为 |
|---|---|---|
| `UserPromptSubmit` | `tdai_memory_recall` | 在本轮开始前召回记忆，并通过 `additionalContext` 注入。 |
| `Stop` | `tdai_memory_capture` | 当 session 没有后台任务或定时唤醒时，保存原始 prompt 和最终 assistant 回复。 |
| `SessionEnd` | `tdai_session_end` | 刷新该 session 的待处理工作。 |

请使用 Claude Code `v2.1.196` 或更高版本。该版本会提供 `prompt_id`，使不同 Hook 进程间的 prompt 和回复能稳定关联。

## 先启动 Gateway

在仓库中安装依赖并启动现有 Gateway：

```bash
npm install --ignore-scripts
node --import tsx src/gateway/server.ts
```

Gateway 默认监听 `http://127.0.0.1:8420`。如果启用了 Bearer token，请在启动 Claude Code 前导出它：

```bash
export TDAI_GATEWAY_API_KEY="your-gateway-token"
```

## 添加生命周期 Hook

把 [`integrations/claude-code/hooks.json`](../integrations/claude-code/hooks.json) 合并到项目级 `.claude/settings.json`，或者全局 `~/.claude/settings.json`。将 `/absolute/path/to/TencentDB-Agent-Memory` 替换为本仓库的绝对路径。

样例使用 command hook 的 exec form，因此路径中包含空格时不需要 shell 转义。在 Claude Code 中运行以下命令检查已注册的 Hook：

```text
/hooks
```

当 `background_tasks` 或 `session_crons` 非空时，`Stop` handler 会跳过 capture。这样 session 只是等待后台工作时，不会被错误当作最终回复写入记忆。

## 添加 MCP server

将 [`integrations/claude-code/mcp.json.example`](../integrations/claude-code/mcp.json.example) 复制到项目根目录并命名为 `.mcp.json`，然后替换样例中的仓库路径。项目级 MCP server 需要先信任工作区并确认批准，Claude Code 才会连接。

也可以通过 CLI 添加同一个 server：

```bash
claude mcp add --transport stdio --scope project memory_tencentdb -- \
  node /absolute/path/to/TencentDB-Agent-Memory/node_modules/tsx/dist/cli.mjs \
  /absolute/path/to/TencentDB-Agent-Memory/src/adapters/mcp/stdio.ts
```

在 Claude Code 中检查连接：

```text
/mcp
```

`memory_tencentdb` server 提供 `tdai_memory_recall`、`tdai_memory_capture`、`tdai_session_end`、`tdai_memory_search` 和 `tdai_conversation_search`。模型可在需要更多细节时按需调用这些工具；自动 recall/capture 不依赖模型主动调用工具。

## 使用环境变量配置 adapter

| 变量 | 默认值 | 用途 |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | 生命周期 Hook 与 MCP adapter 共用的 Gateway 地址。 |
| `TDAI_GATEWAY_API_KEY` | 未设置 | 发送给 Gateway 的 Bearer token。 |
| `TDAI_CLAUDE_CODE_STATE_DIR` | `~/.memory-tencentdb/claude-code-adapter` | 在不同 Hook 进程间共享 pending prompt 和 capture 去重标记。 |

当前一个 Gateway 实例对应一个记忆命名空间；这些 adapter 环境变量不提供用户级命名空间隔离。

状态目录只保存 pending prompt 和短期标记。Prompt 与成功 capture 标记会在 24 小时后过期；被异常终止的 Hook 遗留的 claim 最多 60 秒后可恢复。

## 故障时保持 fail-open

Gateway 出错不会阻断 Claude Code：

- Recall 失败会返回 `{}`，Claude Code 继续使用原始 prompt。
- Capture 和 session end 失败只写入 stderr，Claude Code 仍可停止或退出。
- Capture 失败后会保留 prompt，重复的 `Stop` 事件可以重试。
- Capture 成功后会写入本地标记，防止相同 `session_id + prompt_id` 重复保存。

Capture 采用至少一次投递语义。如果 Gateway 已接受 capture，但 Hook 还未来得及写入本地成功标记就退出，后续 `Stop` 可能再次提交同一轮。重试会复用稳定 message ID，供下游存储去重。

## 手动测试 Hook

在仓库根目录执行一个 recall 事件：

```bash
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"demo","prompt_id":"prompt-1","cwd":"/tmp","prompt":"记住我的回复风格"}' \
  | node node_modules/tsx/dist/cli.mjs src/adapters/claude-code/cli.ts
```

没有匹配记忆时返回 `{}`；召回成功时，返回的 JSON 包含 `hookSpecificOutput.additionalContext`。运行时排查可使用 `claude --debug-file /tmp/claude-hooks.log`，并检查 `/hooks` 和 `/mcp`。

共享 MCP adapter 的工具和启动方式请查看 [MCP adapter 指南](mcp_CN.md)。