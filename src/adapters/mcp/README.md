# memory-tencentdb MCP Adapter

把 TencentDB-Agent-Memory 暴露成 MCP server，让 Claude Code / Codex / Cursor / Cline 等任何 MCP 兼容客户端即插即用。

## 它干啥

TdaiCore 内嵌进一个 MCP server 进程，通过 stdio JSON-RPC 暴露 5 个工具：

| 工具                     | 作用                                | 何时调                              |
| ----------------------- | ----------------------------------- | ----------------------------------- |
| `tdai_memory_search`    | 搜 L1 结构化记忆                     | Agent 推理时主动调                  |
| `tdai_conversation_search` | 搜 L0 原始对话                     | Agent 推理时主动调                  |
| `tdai_recall`           | 触发自动召回，返回要注入的上下文     | 宿主 `UserPromptSubmit` 钩子调       |
| `tdai_capture`          | 触发对话捕获，写 L0 + 调度 pipeline | 宿主 `Stop` 钩子调                  |
| `tdai_session_end`      | flush 单 session 缓冲               | 宿主 `SessionEnd` 钩子调            |

设计上是**模式 C**（进程内 TdaiCore + MCP 协议外露），不走 standalone Gateway 的 HTTP 跳。Claude Code 把这个 server 当子进程拉起，server 内部直接跑记忆引擎。

## 安装（Claude Code）

### 1. 安装包

```bash
npm install -g @tencentdb-agent-memory/memory-tencentdb
```

### 2. 注册 MCP server

项目级（推荐）：在工作目录建 `.mcp.json`：

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "memory-tencentdb-mcp",
      "env": {
        "TDAI_LLM_API_KEY": "sk-...",
        "TDAI_LLM_MODEL": "gpt-4o",
        "TDAI_LLM_BASE_URL": "https://api.openai.com/v1"
      }
    }
  }
}
```

或用户级（影响所有 Claude Code 会话）：

```bash
claude mcp add tdai-memory -- env TDAI_LLM_API_KEY=sk-... TDAI_LLM_MODEL=gpt-4o
```

### 3. 配置宿主钩子（关键）

光有工具不会触发自动召回/捕获——Claude Code 不会在 prompt 边界自动调 MCP 工具。需要在 `~/.claude/settings.json` 配置钩子，把生命周期事件桥到 MCP 工具调用：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "tool",
            "tool": "mcp__tdai-memory__tdai_recall",
            "args": {
              "query": "$PROMPT",
              "session_key": "$SESSION_ID"
            },
            "inject_as": "prepend"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "tool",
            "tool": "mcp__tdai-memory__tdai_capture",
            "args": {
              "user_content": "$LAST_USER_PROMPT",
              "assistant_content": "$LAST_ASSISTANT_REPLY",
              "session_key": "$SESSION_ID"
            },
            "run_in_background": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "tool",
            "tool": "mcp__tdai-memory__tdai_session_end",
            "args": { "session_key": "$SESSION_ID" }
          }
        ]
      }
    ]
  }
}
```

> 上面 `$PROMPT` / `$SESSION_ID` / `$LAST_USER_PROMPT` / `$LAST_ASSISTANT_REPLY` 是 Claude Code 的 hook 变量占位符，实际名称以 Claude Code 当前文档为准——这里写的是设计意图，具体配置语法请参考 Claude Code 官方 hook 文档。

## 安装（Codex / Cursor / 通用 MCP）

Codex、Cursor、Cline 都支持同一个 stdio MCP server。配置语法各平台不同，但核心字段一致：

- 命令：`memory-tencentdb-mcp`
- 参数：（无）
- 环境变量：见下节

## 配置

所有配置走环境变量（无 yaml 文件）：

| 环境变量                    | 必填 | 默认值                              | 说明                                                                 |
| -------------------------- | ---- | ----------------------------------- | -------------------------------------------------------------------- |
| `TDAI_LLM_API_KEY`         | ✅   | —                                   | LLM provider API key                                                 |
| `TDAI_LLM_BASE_URL`        | ❌   | `https://api.openai.com/v1`         | OpenAI 兼容 endpoint                                                 |
| `TDAI_LLM_MODEL`           | ❌   | `gpt-4o`                            | L1/L2/L3 提取用模型                                                  |
| `TDAI_LLM_MAX_TOKENS`      | ❌   | `4096`                              | 单次 LLM 调用最大输出                                                |
| `TDAI_LLM_TIMEOUT_MS`      | ❌   | `120000`                            | LLM 请求超时                                                         |
| `TDAI_LLM_DISABLE_THINKING`| ❌   | `false`                             | 推理模型思考关闭策略（`vllm`/`deepseek`/`dashscope`/`openai`/`anthropic`/`kimi`/`gemini`） |
| `TDAI_DATA_DIR`            | ❌   | `~/.memory-tencentdb/memory-tdai`   | 存储根目录（与其他适配器共享同一目录即可跨平台共用记忆）            |
| `TDAI_USER_ID`             | ❌   | `default_user`                      | 默认用户 ID                                                          |
| `TDAI_MEMORY_CONFIG`       | ❌   | —                                   | 完整 memory 配置 JSON（覆盖默认值，跟 `openclaw.plugin.json` 同结构） |
| `TDAI_MCP_DEBUG`           | ❌   | —                                   | 设为 `1` 开启 DEBUG 级日志（写 stderr）                              |

## 工具参考

### `tdai_memory_search`

参数：

- `query` (string, 必填) — 搜索查询
- `limit` (number, 可选, 默认 5, 上限 20) — 返回结果数
- `type` (enum, 可选) — `persona` | `episodic` | `instruction`
- `scene` (string, 可选) — 按场景名过滤

返回：纯文本，按相关度排序的 L1 记忆列表。

### `tdai_conversation_search`

参数：

- `query` (string, 必填)
- `limit` (number, 可选, 默认 5)
- `session_key` (string, 可选) — 限定单 session

返回：纯文本，L0 对话片段。

### `tdai_recall`

参数：

- `query` (string, 必填) — 用户 prompt 文本
- `session_key` (string, 必填)

返回：JSON 字符串，字段：

```json
{
  "prepend_context": "<注入到用户消息的 L1 相关记忆>",
  "append_system_context": "<注入到系统提示的 persona + 场景导航>",
  "strategy": "hybrid",
  "memory_count": 3
}
```

宿主拿到响应后：

- 把 `prepend_context` 前置到用户消息
- 把 `append_system_context` 追加到系统提示（可跨轮缓存）

### `tdai_capture`

参数：

- `user_content` (string, 必填)
- `assistant_content` (string, 必填)
- `session_key` (string, 必填)
- `session_id` (string, 可选)

返回：JSON 字符串，`{ l0_recorded, scheduler_notified, l0_vectors_written }`。

### `tdai_session_end`

参数：

- `session_key` (string, 必填)

返回：`{ "flushed": true }`。

## 故障排查

### `tools/list` 没返回 tdai_* 工具

检查 MCP server 是否启动成功。Claude Code 日志通常在 `~/.claude/logs/`。手动冒烟：

```bash
echo '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}},"id":1}' | \
  memory-tencentdb-mcp
```

期望：stdout 上返回合法 JSON-RPC，stderr 上看到 `[memory-tdai] [mcp] INFO ...` 日志。

### `Tool call failed: TdaiCore not initialized`

TdaiCore 初始化失败，通常是数据目录权限错或 LLM API key 缺。开 `TDAI_MCP_DEBUG=1` 看 stderr DEBUG 日志。

### `connection reset` 或日志里出现非 JSON 字符

stdout 被日志污染了。本适配器已强制所有日志走 stderr，但如果用户代码或第三方库调了 `console.log`，会破坏 JSON-RPC 协议流。排查：

```bash
TDAI_MCP_DEBUG=1 memory-tencentdb-mcp 2>/dev/null </dev/null
```

正常情况下 stdout 应该完全空（连 initialize 都没等到输入）。

### LLM 调用超时

L1/L2/L3 提取走 StandaloneLLMRunner，单次调用默认 120s 超时。如果模型慢，调高 `TDAI_LLM_TIMEOUT_MS`。

### 跨平台数据不互通

确认所有适配器指向同一 `TDAI_DATA_DIR`。MCP server 默认走 `~/.memory-tencentdb/memory-tdai`，与 standalone Gateway 一致——同机部署无需配置即可共享。

## 进阶：与其他适配器共存

MCP server 跟 standalone Gateway、OpenClaw 插件可以**同时**指向同一个 `dataDir`：

- SQLite 后端用 WAL 模式，支持并发读 + 单写
- 同一时刻只允许一个进程做写操作（文件锁限制）
- 多平台同时高频写入请切到 tcvdb 后端

参考 [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 第 6 节"存储层映射"了解跨平台数据共享的细节。
