# Trae Plugin for TencentDB Agent Memory

Trae lifecycle hooks + MCP tools adapter for the **memory-tencentdb** four-layer memory system (L0 conversation capture → L1 episodic extraction → L2 scene blocks → L3 persona synthesis).

This plugin integrates TencentDB Agent Memory into Trae through two interfaces:

1. **Lifecycle Hooks** — Auto-inject relevant memory context before each turn and capture conversations after each response
2. **MCP Tools** — Provide explicit memory search tools (`tdai_recall`, `tdai_memory_search`, `tdai_conversation_search`) to the LLM

## Architecture

```
Trae Agent
  ├─ Lifecycle Hooks (SessionStart, UserPromptSubmit, Stop, SessionEnd)
  │   └─ memory-hook.mjs  →  TdaiBridge  →  Gateway HTTP API
  └─ MCP Server (stdio JSON-RPC)
      └─ TraeMcpServer  →  TdaiBridge  →  Gateway HTTP API
              │
              ▼  HTTP (127.0.0.1:8420 by default)
      memory-tencentdb Gateway (Node.js)
         └─ memory-tencentdb Core
              ├─ L0  Conversation store      (SQLite / TCVDB + JSONL)
              ├─ L1  Episodic extraction     (LLM + vector dedup)
              ├─ L2  Scene blocks            (Markdown under data dir)
              ├─ L3  Persona synthesis       (persona.md)
              └─ Storage backends: SQLite + sqlite-vec  OR  Tencent VectorDB
```

### Trae Hook → Gateway Mapping

| Trae hook          | Gateway endpoint | Behavior                                                   |
|--------------------|------------------|------------------------------------------------------------|
| `SessionStart`     | `POST /recall`   | Inject initial context for new sessions                    |
| `UserPromptSubmit` | `POST /recall`   | Inject relevant memory context before each user prompt    |
| `Stop`             | `POST /capture`  | Capture the user + assistant conversation turn            |
| `SessionEnd`       | `POST /session/end` | Flush pending pipeline work and close session           |

### MCP Tools

| Tool                        | Purpose                                           | Args                                            |
|-----------------------------|---------------------------------------------------|-------------------------------------------------|
| `tdai_recall`              | Recall memory context for a query                 | `query` (required), `session_key` (required)   |
| `tdai_capture`             | Capture a conversation turn                      | `user_content`, `assistant_content`, `session_key` |
| `tdai_memory_search`       | Search L1 structured long-term memories           | `query` (required), `limit` (1..50, default 10) |
| `tdai_conversation_search` | Search L0 raw conversation history                | `query` (required), `limit` (1..50, default 10) |
| `tdai_session_end`         | End a session and flush pending work              | `session_key` (required)                        |

## Installation

### 1. Install the Plugin

Copy the `trae-plugin/` directory to your Trae plugins location:

```bash
# Assuming you're in the TencentDB-Agent-Memory repository root
mkdir -p ~/.trae/plugins/trae-memory
cp -r trae-plugin/.trae ~/.trae/plugins/trae-memory/
cp -r trae-plugin/scripts ~/.trae/plugins/trae-memory/
```

### 2. Configure Trae to Load the Plugin

In your Trae configuration file (typically `~/.trae/config.json` or equivalent), add:

```jsonc
{
  "plugins": {
    "trae-memory": {
      "enabled": true,
      "hooksConfig": "~/.trae/plugins/trae-memory/.trae/hooks.json",
      "mcpConfig": "~/.trae/plugins/trae-memory/.trae/mcp.json"
    }
  }
}
```

### 3. Set Required Environment Variables

The plugin requires Gateway connection details. Set these in your Trae environment:

```bash
# Gateway endpoint (required)
export TDAI_GATEWAY_URL="http://127.0.0.1:8420"

# Gateway API key if authentication is enabled (required if Gateway has apiKey set)
export TDAI_GATEWAY_API_KEY="your-secret-key"

# Optional: Session key override (defaults to "trae-default")
export TRAE_SESSION_KEY="your-session-key"

# Optional: Request timeout in milliseconds (defaults to 10000)
export TDAI_GATEWAY_TIMEOUT_MS="10000"
```

### 4. Start the Gateway

The plugin connects to a memory-tencentdb Gateway sidecar. Start it separately:

```bash
# From the TencentDB-Agent-Memory repository root
cd /path/to/TencentDB-Agent-Memory
npx tsx src/gateway/server.ts
```

Or use the production build:

```bash
cd /path/to/TencentDB-Agent-Memory
node dist/gateway/server.js
```

**Verify the Gateway is running:**

```bash
curl http://127.0.0.1:8420/health
# Should return: {"status":"ok"} or {"status":"degraded"}
```

## Environment Variables

### Gateway Connection

| Variable                   | Default             | Description                                               |
|----------------------------|---------------------|-----------------------------------------------------------|
| `TDAI_GATEWAY_URL`         | —                   | Gateway base URL (required)                                |
| `TDAI_GATEWAY_API_KEY`     | —                   | Gateway API key if authentication is enabled (required if Gateway has `server.apiKey` set) |
| `TDAI_GATEWAY_TIMEOUT_MS`  | `10000`             | HTTP request timeout in milliseconds                      |

### Session Management

| Variable            | Default           | Description                                      |
|---------------------|-------------------|--------------------------------------------------|
| `TRAE_SESSION_KEY`  | `trae-default`    | Session key for memory isolation                |

## Gateway Configuration

The Gateway handles all memory operations. Configure it via:

- **Environment variables** (recommended for Trae integration)
- **Config file** (`~/.memory-tencentdb/memory-tdai/tdai-gateway.yaml` or `tdai-gateway.json`)

### Key Gateway Settings

| Setting                    | Default | Description                                              |
|----------------------------|---------|----------------------------------------------------------|
| `storeBackend`             | `sqlite`| Storage backend: `sqlite` or `tcvdb`                     |
| `timezone`                 | `system`| Timezone for timestamps                                  |
| `recall.strategy`          | `hybrid`| Recall strategy: `keyword`, `embedding`, or `hybrid`    |
| `recall.maxResults`        | `5`     | Number of memories to recall per request                |
| `pipeline.everyNConversations` | `5`  | Trigger L1 extraction every N turns                     |
| `persona.triggerEveryN`    | `50`    | Generate L3 persona every N new memories                |

For the full configuration schema, see the main [README](../../README.md).

## Troubleshooting

### Plugin not loading in Trae

- **Check file paths**: Ensure `~/.trae/plugins/trae-memory/.trae/hooks.json` and `.trae/mcp.json` exist
- **Verify JSON syntax**: Run `python -m json.tool ~/.trae/plugins/trae-memory/.trae/hooks.json` to validate
- **Check Trae logs**: Look for plugin loading errors in Trae's log output

### "missing env var: TDAI_GATEWAY_URL" error

- **Set required environment variables**: Ensure `TDAI_GATEWAY_URL` is set in Trae's environment
- **Check Gateway is running**: Verify `curl http://127.0.0.1:8420/health` returns successfully

### Memory context not being injected

- **Check hook execution**: Add `--debug` flag to Trae to see hook execution logs
- **Verify Gateway health**: Ensure the Gateway is running and not returning errors
- **Check session key**: Verify `TRAE_SESSION_KEY` is consistent across requests if customizing

### MCP tools not available to the LLM

- **Check MCP server registration**: Verify `memory-tencentdb-trae-mcp` command is available in PATH
- **Check mcp.json syntax**: Run `python -m json.tool ~/.trae/plugins/trae-memory/.trae/mcp.json` to validate
- **Verify Gateway authentication**: If Gateway has `server.apiKey` set, ensure `TDAI_GATEWAY_API_KEY` matches

### Gateway connection failures

- **Check Gateway logs**: Look for errors in Gateway stderr output
- **Verify port**: Ensure Gateway is listening on the port specified in `TDAI_GATEWAY_URL`
- **Test connectivity**: Run `curl -H "Authorization: Bearer $TDAI_GATEWAY_API_KEY" http://127.0.0.1:8420/health`

### Hook script errors

- **Check script syntax**: Run `node --check ~/.trae/plugins/trae-memory/scripts/memory-hook.mjs`
- **Verify compiled outputs exist**: Ensure `pnpm build` has been run and `dist/adapters/trae/hook-handler.js` exists
- **Check error messages**: Hook errors are logged to stderr with `[memory-hook]` prefix

## Architecture Notes

### Hook Protocol

This plugin follows the **Claude-Code-compatible hooks protocol** (Trae has an "import Claude Code hooks" switch). The hook field names in `hooks.json` follow this standard protocol. Real-Trae verification is deferred to integration testing; field format adjustments may be needed based on actual Trae behavior.

### Memory Injection Limits

To prevent context explosion, the plugin enforces a `MAX_CONTEXT_CHARS = 4000` limit. Injected context longer than this is truncated with a `…(truncated)` suffix. This balances memory richness with token efficiency.

### Graceful Degradation

The `TdaiBridge` implementation includes retry logic with exponential backoff for transient errors (network timeouts, 5xx errors). Non-transient errors (authentication, validation) fail immediately. All operations degrade gracefully on failure:
- `recall`: Returns empty context on failure
- `capture`: Returns `{ ok: false }` on failure
- `search`: Returns empty results on failure

This ensures the plugin never crashes the Trae session even if the Gateway is unavailable.

## Related Documentation

- [Main README](../../README.md) — Full TencentDB Agent Memory documentation
- [Hermes Provider README](../../hermes-plugin/memory/memory_tencentdb/README.md) — Similar integration pattern for Hermes agents
- [Gateway Configuration](../../README.md#-configurable-parameters) — Complete Gateway configuration reference

## License

MIT © TencentDB Agent Memory Team
