# Claude Code MCP Adapter

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that
exposes the TDAI memory system to [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
via stdio transport.

## Overview

This adapter bridges Claude Code's MCP-based tool-calling convention with the
TDAI memory Gateway. It extends the `MemoryAdapterBase` SDK class, inheriting
all Gateway communication, circuit breaking, and graceful degradation.

```
Claude Code  <--stdio JSON-RPC-->  TdaiMcpServer  --(calls)-->  ClaudeCodeAdapter
                                                                           |
                                                                 MemoryAdapterBase
                                                                    (recall / capture / search)
                                                                           |
                                                                 MemoryGatewayClient
                                                                    (HTTP v3 API)
```

## Files

| File | Description |
|------|-------------|
| `adapter.ts` | `ClaudeCodeAdapter` class extending `MemoryAdapterBase`, plus the `main()` entry point |
| `mcp-server.ts` | `TdaiMcpServer` implementing JSON-RPC 2.0 over stdio (no external MCP SDK) |
| `index.ts` | Barrel export for all public symbols |

## Tools

The server exposes three memory tools to Claude Code:

### `tdai_memory_search`

Searches structured L1 memories for relevant fragments about user preferences,
past events, rules, and facts.

**Parameters:**
- `query` (string, required) - Search query text (natural language)
- `limit` (number, optional) - Max results to return (default: 5)
- `type` (string, optional) - Filter by memory type (e.g. `persona`, `episodic`, `instruction`)

### `tdai_conversation_search`

Searches raw L0 conversation history for original messages with timestamps.

**Parameters:**
- `query` (string, required) - Search query text
- `limit` (number, optional) - Max results to return (default: 5)
- `session_key` (string, optional) - Filter by session ID

### `tdai_read_scene`

Reads a scene block's full content by its name. Use when a scene is listed in
the Scene Navigation section of recalled context.

**Parameters:**
- `scene_id` (string, required) - Scene file name (e.g. `travel-plan.md`)

## MCP Protocol Support

The server implements the following MCP methods over JSON-RPC 2.0:

| Method | Description |
|--------|-------------|
| `initialize` | Returns server info (`tdai-memory-mcp` v1.0.0) and capabilities |
| `notifications/initialized` | Notification confirming client initialization (no response) |
| `tools/list` | Returns the three tool definitions with input schemas |
| `tools/call` | Dispatches tool invocations to `adapter.handleToolCall()` |
| `ping` | Simple keepalive (returns empty result) |

The server uses native Node.js `readline` for line-by-line stdin reading and
`process.stdout` for writing responses. No external `@modelcontextprotocol/sdk`
dependency is required.

## Configuration

All configuration is read from environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `TDAI_GATEWAY_ENDPOINT` | Gateway base URL | `http://127.0.0.1:8420` |
| `TDAI_GATEWAY_API_KEY` | Bearer API key for authentication | (none) |
| `TDAI_GATEWAY_SERVICE_ID` | Service / instance ID for multi-tenant routing | `default` |
| `TDAI_GATEWAY_TIMEOUT_MS` | Request timeout in milliseconds | `10000` |
| `TDAI_GATEWAY_REJECT_UNAUTHORIZED` | Set to `false` to disable TLS cert validation | `true` |
| `TDAI_TEAM_ID` | Team (tenant) identifier | `default` |
| `TDAI_AGENT_ID` | Agent identifier | `default` |
| `TDAI_USER_ID` | User identifier | `default` |
| `TDAI_SESSION_ID` | Default session identifier | (none) |
| `TDAI_CAPTURE_ENABLED` | Set to `false` to disable conversation capture | `true` |
| `TDAI_RECALL_MAX_RESULTS` | Max L1 memories to recall per turn | `5` |

## Usage

### Standalone MCP Server

Run the adapter as a standalone process that Claude Code connects to via
stdio:

```bash
# Set required environment variables
export TDAI_GATEWAY_ENDPOINT=http://127.0.0.1:8420
export TDAI_GATEWAY_API_KEY=your-api-key
export TDAI_TEAM_ID=my-team
export TDAI_USER_ID=alice

# Start the server (after building)
node dist/adapters/claude-code/adapter.js
```

### Claude Code Configuration

Add the MCP server to your Claude Code configuration
(`~/.claude/claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "node",
      "args": ["/path/to/dist/adapters/claude-code/adapter.js"],
      "env": {
        "TDAI_GATEWAY_ENDPOINT": "http://127.0.0.1:8420",
        "TDAI_GATEWAY_API_KEY": "your-api-key",
        "TDAI_TEAM_ID": "my-team",
        "TDAI_AGENT_ID": "default",
        "TDAI_USER_ID": "alice"
      }
    }
  }
}
```

### Programmatic Usage

```typescript
import { ClaudeCodeAdapter, TdaiMcpServer } from "./claude-code/index.js";

// Create and initialize the adapter
const adapter = new ClaudeCodeAdapter({
  gateway: {
    endpoint: "http://127.0.0.1:8420",
    apiKey: "secret",
  },
  tenancy: {
    teamId: "my-team",
    userId: "alice",
  },
});

await adapter.initialize(adapter.resolveConfig());

// Use the adapter directly
const result = await adapter.handleToolCall("tdai_memory_search", {
  query: "user preferences",
  limit: 5,
});
console.log(result);

// Or start the MCP server
const server = new TdaiMcpServer(adapter);
server.start();
```

## Recall Result Format

When `adapter.recall()` is called, the `formatRecallResult()` method produces
XML-tagged context blocks compatible with Claude's prompt format:

**prependContext** (injected before the user's message):
```xml
<relevant-memories>

- [persona] (score: 0.952) Prefers dark mode and concise answers
- [episodic] (score: 0.871) Discussed React state management on 2024-03-15

</relevant-memories>
```

**appendSystemContext** (appended to the system prompt):
```xml
<user-persona>
Alice is a senior frontend developer who values clean, minimal code...
</user-persona>

<scene-navigation>
The following scene memory index is available. Use tdai_read_scene to read any scene's full content.

- `scene_blocks/travel-plan.md` — Summer vacation planning
- `scene_blocks/project-setup.md` — React project initialization
</scene-navigation>

<memory-tools-guide>
## Memory Tools Guide
...
</memory-tools-guide>
```

## Message Normalization

The `normalizeMessages()` method handles Claude Code's message format, which
uses an array of `{ role, content }` objects. The `content` field may be:

- A plain string
- An array of content blocks (`{ type: "text", text: "..." }`,
  `{ type: "tool_use", name: "...", input: {...} }`,
  `{ type: "tool_result", content: "..." }`)

All block types are extracted into plain text for L0 conversation recording.

## Error Handling

- **Circuit breaker**: After 5 consecutive Gateway failures, all tool calls
  return empty results for 60 seconds before retrying.
- **Graceful degradation**: All methods return empty results on failure rather
  than throwing, so Claude Code never crashes.
- **Logging**: All diagnostic output goes to stderr to avoid corrupting the
  JSON-RPC stream on stdout.
- **Graceful shutdown**: SIGINT and SIGTERM trigger clean shutdown of the
  readline interface and adapter.

## Architecture Notes

- **No external MCP SDK**: The server implements JSON-RPC 2.0 directly using
  Node.js `readline` and `process.stdout`, avoiding the
  `@modelcontextprotocol/sdk` dependency.
- **Stdio transport**: stdin reads JSON-RPC requests line by line; stdout
  writes one JSON-RPC response per line.
- **Protocol version**: `2024-11-05` (MCP specification version).
