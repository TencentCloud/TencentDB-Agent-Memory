# Claude Code 适配器 — MCP stdio 记忆服务器

> English version: [README.md](./README.md)。
> 构建于 [Adapter SDK](../../adapter-sdk/README_CN.md) · 与其他平台的对比见
> [PLATFORM-COMPARISON_CN.md](../../../docs/adapters/PLATFORM-COMPARISON_CN.md)

`TdaiMcpServer` 通过 MCP **stdio** 传输，把 TDAI 记忆引擎以五个工具的形式暴露给 Claude
Code（或任何 MCP 客户端）。协议为手写实现（spec rev 2025-06-18 的 initialize / ping /
tools-list / tools-call 子集）— 零新增依赖，延续本仓库 Gateway 的零框架风格。

## 工具

| 工具 | 映射到 | 用途 |
| --- | --- | --- |
| `memory_recall` | `MemoryClient.recall` | 按查询加载画像/场景/记忆上下文 |
| `memory_capture` | `MemoryClient.capture` | 把一轮 user+assistant 对话存入记忆 |
| `memory_search` | `MemoryClient.searchMemories` | 搜索 L1 结构化记忆（支持 type/scene 过滤） |
| `conversation_search` | `MemoryClient.searchConversations` | 搜索 L0 原始对话历史 |
| `memory_session_end` | `MemoryClient.endSession` | 冲刷本会话的流水线缓冲 |

所有工具都接受可选 `session_key` 覆盖服务器默认值。`limit` 收敛到 1..20（默认 5），与
OpenClaw 的工具注册完全一致。

## 部署

### 1. 启动记忆后端

默认传输是 `http` — 先跑 Gateway：

```bash
npm run gateway          # TdaiGateway 监听 http://127.0.0.1:8420
```

（或设 `TDAI_ADAPTER_TRANSPORT=in-process` 把引擎内嵌进 MCP 服务器进程 — 无需 gateway；
存储位于 `TDAI_DATA_DIR`。）

### 2. 注册到 Claude Code

项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/to/repo/src/adapters/claude-code/main.ts"],
      "env": {
        "TDAI_GATEWAY_URL": "http://127.0.0.1:8420",
        "TDAI_SESSION_KEY": "claude-code:my-project"
      }
    }
  }
}
```

CLI 等价写法：

```bash
claude mcp add tdai-memory \
  --env TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
  -- node --import tsx /absolute/path/to/repo/src/adapters/claude-code/main.ts
```

### 3. 验证

在 Claude Code 里执行 `/mcp` — `tdai-memory` 应列出 5 个工具。也可手工冒烟：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | npm run -s adapter:claude-code
```

## 环境变量

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `TDAI_ADAPTER_TRANSPORT` | `http` \| `in-process` | `http` |
| `TDAI_GATEWAY_URL` | gateway 地址（http 传输） | `http://127.0.0.1:8420` |
| `TDAI_GATEWAY_API_KEY` | gateway 开启鉴权时的 Bearer 令牌 | 未设 |
| `TDAI_ADAPTER_TIMEOUT_MS` | 到 gateway 的单请求超时 | `10000` |
| `TDAI_SESSION_KEY` | 默认记忆会话 | `claude-code:<目录名>` |
| `TDAI_USER_ID` | 预留 — 随 recall/capture 请求发送，但当前引擎会忽略（单用户） | `default_user` |

## 可选：基于钩子的自动捕获

工具式捕获依赖模型主动调用 `memory_capture`。要实现（OpenClaw 式的）自动捕获，可给
Claude Code 加一个 **Stop 钩子**，在每次响应结束时把最后一组对话 POST 给 Gateway。写在
`~/.claude/settings.json`（或项目 `.claude/settings.json`）：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.transcript_path' | xargs -I{} sh -c 'jq -rs '\''[.[] | select(.type==\"user\" or .type==\"assistant\")] | .[-2:] | {user_content: (map(select(.type==\"user\"))[-1].message.content // \"\" | if type==\"array\" then (map(select(.type==\"text\").text)|join(\" \")) else . end), assistant_content: (map(select(.type==\"assistant\"))[-1].message.content // \"\" | if type==\"array\" then (map(select(.type==\"text\").text)|join(\" \")) else . end), session_key: \"claude-code:hook\"}'\'' {} | curl -s -X POST \"$TDAI_GATEWAY_URL/capture\" -H \"Content-Type: application/json\" -d @-'"
          }
        ]
      }
    ]
  }
}
```

**这份配方的诚实边界：** Stop 钩子载荷与 transcript JSONL 格式属于 Claude Code 的实现细节，
可能随版本演进；上面的文本提取覆盖了常见的字符串/数组 content 形态但并非所有块类型；
Stop 时捕获是尽力而为（没有 Hermes Provider 那样的重试/熔断）。因此它以*可选配方*的形式写
在文档里，而不是作为适配器依赖的代码交付 — 受支持的写路径是 `memory_capture` 工具。

## 设计要点

- **日志只走 stderr。** stdout 只承载协议行；污染 stdout 是 stdio-MCP 最经典的故障模式。
  `main.ts` 构建 stderr 日志器；服务器本体绝不 `console.log`。
- **版本协商**：`2025-06-18 / 2025-03-26 / 2024-11-05` 之内原样回显，否则回复最新支持版本。
- **工具错误 vs 协议错误。** 引擎/传输失败返回 `isError: true` 结果（模型可见、可应对）；
  只有未知工具/畸形请求才产生 JSON-RPC 错误。
- **`conversation_search` 不默认填 `session_key`** — 在该工具里它是过滤器，默认填上会
  悄悄屏蔽其他会话的历史。
