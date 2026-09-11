# TencentDB Agent Memory MCP Server

This directory is a Python adapter for the existing TencentDB Agent Memory Gateway.
It does not import or modify the existing Gateway, Core, OpenClaw plugin, or Hermes provider code.
The canonical TypeScript Gateway integration boundary remains `GatewayMemoryClient`
and `createGatewayPlatformAdapter()` under `src/adapters/gateway-client`; this
package keeps only the MCP stdio/protocol glue and a private HTTP transport for
forwarding MCP tool calls to the Gateway.

Runtime path:

```text
MCP client -> Python MCP server -> Gateway HTTP API -> existing memory system
```

## MCP Tools

The MCP surface follows the Hermes provider `get_tool_schemas()` boundary:

- `tdai_memory_search`: search L1 structured memories.
- `tdai_conversation_search`: search L0 raw conversations.

Lifecycle actions are not exposed through `tools/list`; this package only handles MCP search tools.

## MCP Side-Channel

Use `tdai-memory-mcp health` as an adapter diagnostic side-channel. It does not appear in MCP `tools/list`.

```bash
tdai-memory-mcp health
```

## Configuration

Environment variables:

```bash
TDAI_GATEWAY_URL=http://127.0.0.1:8420
TDAI_GATEWAY_API_KEY=
TDAI_SESSION_KEY=
TDAI_USER_ID=
TDAI_REQUEST_TIMEOUT_MS=30000
```

Session key resolution:

```text
tool argument session_key > TDAI_SESSION_KEY > generated mcp:<cwd-name>:<cwd-hash>
```

## Run

Start or deploy the TDAI Gateway separately before launching the MCP server.
This package does not start, configure, or own the Gateway process.

With Gateway already listening on `http://127.0.0.1:8420`:

```bash
cd packages/tdai-memory-mcp
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
python3 -m tdai_memory_mcp
```

## Test

Unit tests do not require a running Gateway:

```bash
cd packages/tdai-memory-mcp
python3 -m pytest tests/unit -q
```

The real E2E test requires a running Gateway:

```bash
cd packages/tdai-memory-mcp
TDAI_MCP_E2E=1 \
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
python3 -m pytest tests/e2e -q
```
