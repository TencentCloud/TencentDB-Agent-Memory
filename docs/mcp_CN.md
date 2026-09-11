# 运行 memory-tencentdb MCP adapter

`src/adapters/mcp/` 把现有 Gateway 暴露为标准 stdio MCP server，不会创建第二套 memory core 或存储。

## 工具

| 工具 | Gateway endpoint | 类型 |
|---|---|---|
| `tdai_memory_recall` | `POST /recall` | 只读 |
| `tdai_memory_capture` | `POST /capture` | 写入 |
| `tdai_session_end` | `POST /session/end` | 写入 |
| `tdai_memory_search` | `POST /search/memories` | 只读 |
| `tdai_conversation_search` | `POST /search/conversations` | 只读 |

MCP adapter 使用 `TDAI_GATEWAY_URL` 和 `TDAI_GATEWAY_API_KEY`。启动命令为：

```bash
node node_modules/tsx/dist/cli.mjs src/adapters/mcp/stdio.ts
```

通常由 MCP client 通过 stdio 配置启动该进程。不要在终端中启动后手工输入请求；stdin 和 stdout 用于传输 MCP JSON-RPC 消息。

平台 adapter 可以复用 `createMemoryTools()` 完成确定性的 lifecycle Hook。这样 Gateway 调用只存在于一个 adapter 中，同时不会引入第二套通用 SDK 或 BaseAdapter。