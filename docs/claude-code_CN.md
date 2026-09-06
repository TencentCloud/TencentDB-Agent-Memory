# 在 Claude Code 中使用 TencentDB Agent Memory

Claude Code 使用两种接入方式，底层复用同一个 Gateway HTTP client。stdio MCP server 向模型暴露工具；生命周期 Hook 则直接调用 `MemoryTools`，确定性执行自动 recall、capture 和 session flush。Hook 请求不会经过 stdio MCP server。

| Claude Code 事件 | MCP 操作 | 行为 |
|---|---|---|
| `UserPromptSubmit` | `tdai_memory_recall` | 在本轮开始前召回记忆，并通过 `additionalContext` 注入。 |
| `Stop` | `tdai_memory_capture` | 当 session 没有后台任务或定时唤醒时，保存刚结束的回合：有转录时是完整回合（prompt、工具调用、工具结果、中间回复、最终回复），否则只有 prompt 和最终回复。 |
| `SessionEnd` | `tdai_memory_capture`，然后 `tdai_session_end` | 发送转录中尚未发送的部分（Stop 被跳过或未完整落库的回合），再刷新该 session 的待处理工作。 |

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

### 转录捕获

hook 载荷中的 `transcript_path` 指向 session 转录（缺省时按 `<config dir>/projects/<cwd 中非字母数字替换为 "-">/<session_id>.jsonl` 定位）。`Stop` 与 `SessionEnd` 都会读取它，把每个 session 的 marker 之后的条目作为 L0 消息发送，因此工具调用、工具结果与中间回复都会进入记忆，而不只是 prompt 和最终回复：

- `Stop` 时的增量就是刚结束的回合，作为一次 capture 发送，`user_content` / `assistant_content` 即 prompt 与最终回复。按回合发送让每次 Stop 保持小体量：100 条消息的 Gateway 批次需要数秒，而一个 session 的 `SessionEnd` 只触发一次，全部留到最后会丢失长 session 的尾部。
- `SessionEnd` 时的增量是尚未发送的部分，例如因后台任务运行而跳过了 Stop 的回合。
- thinking 与图片丢弃。tool_use 转为 assistant 文本 `[tool_use id=… name=… input=…]`（input 最多引用 2000 字符）；tool_result 转为 user 文本 `[tool_result tool_use_id=…] …`（最多 4000 字符）。超过 8192 字符的消息分块；每批最多 100 条。
- 发送前会把凭证形状的片段（私钥、Bearer token、`sk-…` 密钥、GitHub / GitLab / Slack / AWS / Google / npm token、`password=…` 之类的值）替换为 `[redacted:<kind>]`。工具流量经常带有 env 输出和配置文件，共享记忆里不能出现这些。
- 由旧的"prompt + 最终回复"路径捕获的回合（当时没有转录可读）之后只补发工具流量，不会重复落库。Gateway 只记录收到的内容，不按消息 id 去重。
- marker 记录最后发送的转录条目。失败的批次不推进 marker；未完整落库的回合不会被标记为已捕获，由 `SessionEnd` 补发剩余部分。resume 后再次结束的 session 只发送新增部分。
- 时间预算：Stop 用 `TDAI_CLAUDE_CODE_STOP_BUDGET_MS`（默认 3500），SessionEnd 用 `TDAI_CLAUDE_CODE_TRANSCRIPT_BUDGET_MS`（默认 25000）。预算只阻止新批次开始；进行中的批次会跑到自己的 Gateway 超时 `TDAI_CLAUDE_CODE_TRANSCRIPT_TIMEOUT_MS`（默认 15000）。hook 的 `timeout` 必须覆盖进行中的批次，否则 Gateway 已记录的批次不会写下 marker：样例中 `Stop` 为 15 秒，`SessionEnd` 为 30 秒。
- 设置 `TDAI_CLAUDE_CODE_TRANSCRIPT_CAPTURE=off` 可恢复旧行为：Stop 只发 prompt 与最终回复，SessionEnd 只 flush。

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

`memory_tencentdb` server 提供 Gateway 工具 `tdai_memory_recall`、`tdai_memory_capture`、`tdai_session_end`、`tdai_memory_search`、`tdai_conversation_search`，以及 Knowledge Service（团队 wiki）工具 `tdai_wiki_list`、`tdai_wiki_search`、`tdai_wiki_pages`、`tdai_wiki_read`、`tdai_wiki_write`。模型可在需要更多细节时按需调用这些工具；自动 recall/capture 不依赖模型主动调用工具。请在项目说明（例如 `CLAUDE.md`）中告诉模型应使用哪个 wiki id；adapter 不会预设任何 wiki。

## 使用环境变量配置 adapter

| 变量 | 默认值 | 用途 |
|---|---|---|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | 生命周期 Hook 与 MCP adapter 共用的 Gateway 地址。 |
| `TDAI_GATEWAY_API_KEY` | 未设置 | 发送给 Gateway 的 Bearer token。 |
| `TDAI_CLAUDE_CODE_STATE_DIR` | `~/.memory-tencentdb/claude-code-adapter` | 在不同 Hook 进程间共享 pending prompt 和 capture 去重标记。 |
| `TDAI_CLAUDE_CODE_TRANSCRIPT_CAPTURE` | `on` | 设为 `off` 跳过 Stop 与 SessionEnd 的转录捕获。 |
| `TDAI_CLAUDE_CODE_STOP_BUDGET_MS` | `3500` | Stop 时发送本回合转录批次的时间预算。 |
| `TDAI_CLAUDE_CODE_TRANSCRIPT_BUDGET_MS` | `25000` | SessionEnd 发送剩余转录批次的时间预算。 |
| `TDAI_CLAUDE_CODE_TRANSCRIPT_TIMEOUT_MS` | `15000` | 单个转录批次的 Gateway 超时（recall 与逐轮 capture 仍为 3 秒默认值）。 |
| `TDAI_KNOWLEDGE_URL` | `http://127.0.0.1:8424` | wiki 工具使用的 Knowledge Service 地址（仅 MCP adapter）。 |
| `TDAI_SERVICE_ID`、`TDAI_TEAM_ID`、`TDAI_USER_ID`、`TDAI_AGENT_ID` | 见 [MCP adapter 指南](mcp_CN.md) | wiki 工具使用的服务与租户身份。 |

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