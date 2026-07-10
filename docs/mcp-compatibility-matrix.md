# MCP 客户端兼容性矩阵

> `src/adapters/mcp/mcp-server.ts` 实现了标准 MCP stdio JSON-RPC 协议。
> 以下平台均可通过一行配置接入。

## 已验证兼容的 MCP 客户端

| 客户端 | MCP 协议版本 | 接入方式 | 配置示例 | 工具兼容性 |
|:---|:---|:---|:---|:---:|
| **Claude Code** | 2025-11-25 | stdio | `.mcp.json` 或 `CLAUDE.md` | ✅ 全部5个 |
| **Codex CLI** | 2025-11-25 | stdio | `.codex/config.toml` | ✅ 全部5个 |
| **Cursor** | 2025-06-18 | stdio | `.cursor/mcp.json` | ✅ 全部5个 |
| **Trae** | 2025-11-25 | stdio | `mcp.json` | ✅ 全部5个 |
| **Windsurf** | 2025-03-26 | stdio | `mcp.json` | ✅ 全部5个 |
| **CodeBuddy** | 2025-11-25 | stdio | IDE MCP 配置面板 | ✅ 全部5个 |
| **Continue.dev** | 2025-06-18 | stdio | `config.json` | ✅ 全部5个 |

## 通用配置模板

### JSON 格式（Claude Code、Cursor、Trae、Windsurf、CodeBuddy）

```json
{
  "mcpServers": {
    "tencentdb-memory": {
      "command": "memory-tencentdb-mcp",
      "env": {
        "TDAI_GATEWAY_URL": "http://127.0.0.1:8420",
        "TDAI_GATEWAY_API_KEY": "your-api-key"
      }
    }
  }
}
```

### TOML 格式（Codex CLI）

```toml
[mcp_servers.tencentdb_memory]
command = "memory-tencentdb-mcp"
env = { TDAI_GATEWAY_URL = "http://127.0.0.1:8420", TDAI_GATEWAY_API_KEY = "your-api-key" }
startup_timeout_sec = 10
tool_timeout_sec = 30
```

## 可用的 MCP 工具

| Tool | 功能 | 幂等 | 副作用 |
|:---|:---|:---:|:---:|
| `tdai_recall` | 召回当前会话相关记忆 | ✅ | 无 |
| `tdai_memory_search` | 搜索结构化L1记忆 | ✅ | 无 |
| `tdai_conversation_search` | 搜索原始L0对话 | ✅ | 无 |
| `tdai_capture` | 持久化一个完成的对话轮次 | ❌ | 写入 |
| `tdai_session_end` | 刷新会话的待处理工作 | ❌ | 写入 |

## 协议合规性

MCP 服务器实现了完整的 JSON-RPC 2.0 协议：

- ✅ `initialize` 握手（含 `protocolVersion` 协商）
- ✅ `tools/list` 返回工具列表
- ✅ `tools/call` 执行工具调用
- ✅ `ping` 心跳
- ✅ 通知处理（无 id 的消息不产生响应）
- ✅ 标准错误码：`-32700`（PARSE_ERROR）、`-32601`（METHOD_NOT_FOUND）、`-32602`（INVALID_PARAMS）、`-32603`（INTERNAL_ERROR）
