# TDAI Memory MCP Server

A pure JSON-RPC 2.0 stdio server that exposes TencentDB Agent Memory capabilities to any MCP-compatible client.

## Supported Platforms

- Claude Code
- Trae IDE / Trae CLI
- Codex CLI
- Cursor
- CodeBuddy
- Windsurf

## Tools

| Tool | Description |
|------|-------------|
| `tdai_health` | Gateway health check |
| `tdai_recall` | Recall relevant memories for a query |
| `tdai_capture` | Capture a conversation turn |
| `tdai_memory_search` | Search L1 structured memories |
| `tdai_conversation_search` | Search L0 raw conversations |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway endpoint |
| `TDAI_API_KEY` | (empty) | Bearer token for Gateway auth |
| `TDAI_SERVICE_ID` | `default` | Service/tenant isolation |
| `TDAI_RATE_LIMIT_RPM` | `60` | Max requests per minute |

### Platform Integration

#### Claude Code (`~/.claude/claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "python3",
      "args": ["-m", "adapters.mcp-server.server"],
      "cwd": "/path/to/TencentDB-Agent-Memory",
      "env": { "TDAI_GATEWAY_URL": "http://127.0.0.1:8420" }
    }
  }
}
```

#### Trae CLI (`~/.trae/mcp.json`)
```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "python3",
      "args": ["/path/to/TencentDB-Agent-Memory/adapters/mcp-server/server.py"],
      "env": { "TDAI_GATEWAY_URL": "http://127.0.0.1:8420" }
    }
  }
}
```

#### Codex CLI (`~/.codex/config.toml`)
```toml
[mcp_servers.tdai_memory]
command = "python3"
args = ["/path/to/TencentDB-Agent-Memory/adapters/mcp-server/server.py"]
```

#### Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "python3",
      "args": ["/path/to/TencentDB-Agent-Memory/adapters/mcp-server/server.py"]
    }
  }
}
```

#### CodeBuddy CLI
```bash
codebuddy mcp add --scope user tdai_memory -- python3 /path/to/adapters/mcp-server/server.py
```

## Defense Gates

| Gate | Function |
|------|----------|
| G0 | JSON-RPC schema validation |
| G1 | API key authentication (Bearer token) |
| G2 | Rate limiting (sliding window) |
| G3 | Circuit breaker (5 failures → 30s pause) |

## Requirements

- Python 3.10+ (stdlib only, no pip dependencies)
- TDAI Gateway running locally or remotely
