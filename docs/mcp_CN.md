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

以上 Gateway 工具使用 `TDAI_GATEWAY_URL` 和 `TDAI_GATEWAY_API_KEY`。

## Wiki 工具

同一个 server 还暴露 Knowledge Service（团队 wiki）。wiki id 始终是工具参数，先用 `tdai_wiki_list` 查询。

| 工具 | Knowledge Service endpoint | 类型 |
|---|---|---|
| `tdai_wiki_list` | `POST /v3/wiki/list` | 只读 |
| `tdai_wiki_search` | `POST /v3/wiki/search` | 只读 |
| `tdai_wiki_pages` | `POST /v3/wiki/page/ls` | 只读 |
| `tdai_wiki_read` | `POST /v3/wiki/page/read` | 只读，每次最多 20 个 ref |
| `tdai_wiki_write` | `POST /v3/wiki/page/write` | 写入，每次最多 20 个页面 |

| 变量 | 默认值 | 用途 |
|---|---|---|
| `TDAI_KNOWLEDGE_URL` | `http://127.0.0.1:8424` | Knowledge Service 地址。 |
| `TDAI_KNOWLEDGE_API_KEY` | 回退到 `TDAI_GATEWAY_API_KEY` | 发送给 Knowledge Service 的可选 Bearer token。 |
| `TDAI_SERVICE_ID` | `default` | 作为 `x-tdai-service-id` 请求头发送。 |
| `TDAI_TEAM_ID`、`TDAI_USER_ID`、`TDAI_AGENT_ID` | 未设置 | 随每个请求体发送的租户身份；未设置的字段会被省略。 |
| `TDAI_KNOWLEDGE_TIMEOUT_MS` | `15000` | 单次请求超时。写入和冷启动的存储比 Gateway 调用慢。 |

Knowledge Service 的响应都是 `{ code, message, data }` 信封；工具返回 `data`，非零 `code` 会转成工具错误。给 `createMemoryMcpServer()` 传入 `knowledge: false` 可以只注册 Gateway 工具。

启动命令为：

```bash
node node_modules/tsx/dist/cli.mjs src/adapters/mcp/stdio.ts
```

通常由 MCP client 通过 stdio 配置启动该进程。不要在终端中启动后手工输入请求；stdin 和 stdout 用于传输 MCP JSON-RPC 消息。

平台 adapter 可以复用 `createMemoryTools()` 完成确定性的 lifecycle Hook，复用 `createKnowledgeTools()` 访问 wiki。这样 Gateway 与 Knowledge Service 调用只存在于一个 adapter 中，同时不会引入第二套通用 SDK 或 BaseAdapter。