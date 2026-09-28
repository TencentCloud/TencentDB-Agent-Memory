# TencentDB Agent Memory MCP Server

This directory is a Python adapter for the existing TencentDB Agent Memory Gateway.
It does not import or modify the existing Gateway, Core, OpenClaw plugin, or Hermes provider code.

Runtime path:

```text
MCP client -> Python mcp-server -> TDAI Gateway HTTP API -> existing memory system
```

## MCP Tools

The MCP surface follows the Hermes provider `get_tool_schemas()` boundary:

- `tdai_memory_search`: search L1 structured memories.
- `tdai_conversation_search`: search L0 raw conversations.

Lifecycle actions are not exposed through `tools/list`; they live in the separate `packages/tdai-memory-cli/` project.

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
TDAI_GATEWAY_AUTO_START=1
TDAI_GATEWAY_CONFIG=/Users/bytedance/.codex/tdai-memory/tdai-gateway.yaml
TDAI_DATA_DIR=/Users/bytedance/.codex/tdai-memory/data
TDAI_GATEWAY_CWD=/Users/bytedance/proj/TencentDB-Agent-Memory
TDAI_GATEWAY_CMD=
TDAI_GATEWAY_STARTUP_TIMEOUT_MS=30000
TDAI_GATEWAY_HEALTH_POLL_MS=500
```

Session key resolution:

```text
tool argument session_key > TDAI_SESSION_KEY > generated mcp:<cwd-name>:<cwd-hash>
```

## Run

The MCP server can auto-start the existing Gateway when `TDAI_GATEWAY_AUTO_START=1`.
For Codex installs, `scripts/install-codex.sh` writes the default Gateway config
to `~/.codex/tdai-memory/tdai-gateway.yaml` and stores memory files under
`~/.codex/tdai-memory/data/`. For Claude Code installs,
`scripts/install-claude-code.sh` writes the default Gateway config to
`~/.claude/tdai-memory/tdai-gateway.yaml` and stores memory files under
`~/.claude/tdai-memory/data/`. For local Ollama-based testing:

```bash
cd packages/tdai-memory-mcp
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
TDAI_GATEWAY_AUTO_START=1 \
TDAI_GATEWAY_CONFIG=/Users/bytedance/.codex/tdai-memory/tdai-gateway.yaml \
TDAI_DATA_DIR=/Users/bytedance/.codex/tdai-memory/data \
TDAI_GATEWAY_CWD=/Users/bytedance/proj/TencentDB-Agent-Memory \
python3 -m tdai_memory_mcp
```

If you prefer to start Gateway separately, run this from the repository root:

```bash
TDAI_GATEWAY_CONFIG=/Users/bytedance/.codex/tdai-memory/tdai-gateway.yaml \
TDAI_DATA_DIR=/Users/bytedance/.codex/tdai-memory/data \
node --import tsx src/gateway/server.ts
```

Then start MCP with `TDAI_GATEWAY_AUTO_START` unset.

## Test

Unit tests do not require a running Gateway:

```bash
cd packages/tdai-memory-mcp
python3 -m pytest tests/unit -q
```

The real E2E test requires local Ollama. Gateway can be auto-started by the adapter supervisor:

```bash
cd packages/tdai-memory-mcp
TDAI_MCP_E2E=1 \
TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
TDAI_GATEWAY_AUTO_START=1 \
TDAI_GATEWAY_CONFIG=/Users/bytedance/.codex/tdai-memory/tdai-gateway.yaml \
TDAI_DATA_DIR=/Users/bytedance/.codex/tdai-memory/data \
TDAI_GATEWAY_CWD=/Users/bytedance/proj/TencentDB-Agent-Memory \
python3 -m pytest tests/e2e -q
```
