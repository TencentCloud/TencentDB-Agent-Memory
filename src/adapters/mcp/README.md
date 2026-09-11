# TDAI Memory — MCP Server Adapter

Exposes the TDAI four-layer memory engine (L0 → L1 → L2 → L3) to any
**MCP host** — Claude Code, Codex CLI, Cursor, Cline, Windsurf — over the
Model Context Protocol's stdio transport.

One small server, many platforms: MCP is the shared integration surface, so a
single adapter unlocks every MCP-capable agent instead of writing one plugin
per host.

```
┌──────────────┐   MCP (JSON-RPC 2.0 / stdio)   ┌───────────────┐   HTTP    ┌───────────┐
│  MCP host    │ ─────────────────────────────► │ TDAI MCP      │ ────────► │  TDAI     │
│ (Claude Code,│ ◄───────────────────────────── │ server        │ ◄──────── │  Gateway  │
│  Codex, …)   │       tools/list, tools/call    │ (this adapter)│           │  + Core   │
└──────────────┘                                 └───────────────┘           └───────────┘
```

The adapter is a **thin client**: all memory logic lives in the Gateway/Core.
It is built entirely on the [unified adapter SDK](../../sdk/README.md)
(`GatewayMemoryAdapter` + `buildMemoryTools`), so it contains no bespoke
transport or retry code of its own.

## Tools

| Tool | Layer | Read/Write | Purpose |
| :--- | :---- | :--------- | :------ |
| `tdai_memory_search`        | L1 | read  | Search structured long-term memories |
| `tdai_conversation_search`  | L0 | read  | Search raw past dialogue |
| `tdai_recall`               | L1+L3 | read | Fetch the recall context block for a query |
| `tdai_capture`              | L0 | write | Persist a completed user/assistant turn |

## Prerequisites: a running Gateway

The MCP server talks to a TDAI Gateway over HTTP. Start one first (it owns the
on-disk memory store and the LLM pipeline):

```bash
# from the repo root — the Gateway listens on 127.0.0.1:8420 by default
MEMORY_TENCENTDB_LLM_API_KEY=sk-... npx tsx src/gateway/server.ts
```

Verify it is up:

```bash
curl -s http://127.0.0.1:8420/health
# {"status":"ok",...}
```

> The Gateway is the same sidecar the Hermes provider uses. If you already run
> it for Hermes, the MCP server can share it — one memory store, many platforms.

## Configuration

The server reads these environment variables:

| Env var | Default | Meaning |
| :------ | :------ | :------ |
| `TDAI_GATEWAY_URL`     | `http://127.0.0.1:8420` | Gateway base URL |
| `TDAI_GATEWAY_API_KEY` | *(unset)* | Bearer token, if the Gateway enforces auth |
| `TDAI_MCP_SESSION_KEY` | `mcp-default` | Session id used for `recall`/`capture` grouping |

Replace `/ABS/PATH` below with the absolute path to this repo checkout.

### Claude Code

```bash
claude mcp add tdai-memory \
  --env TDAI_GATEWAY_URL=http://127.0.0.1:8420 \
  -- npx -y tsx /ABS/PATH/src/adapters/mcp/server.ts
```

Or add it to `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABS/PATH/src/adapters/mcp/server.ts"],
      "env": { "TDAI_GATEWAY_URL": "http://127.0.0.1:8420" }
    }
  }
}
```

If the package is installed (`npm i -g @tencentdb-agent-memory/memory-tencentdb`),
use the bin instead: `"command": "tdai-memory-mcp"`, `"args": []`.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.tdai_memory]
command = "npx"
args = ["-y", "tsx", "/ABS/PATH/src/adapters/mcp/server.ts"]
env = { TDAI_GATEWAY_URL = "http://127.0.0.1:8420" }
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tdai-memory": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABS/PATH/src/adapters/mcp/server.ts"],
      "env": { "TDAI_GATEWAY_URL": "http://127.0.0.1:8420" }
    }
  }
}
```

### Cline / any generic MCP host

Cline and most other hosts accept the same `mcpServers` object as Cursor —
copy the block above into the host's MCP settings.

## Verifying without a host

Drive the protocol by hand — pipe JSON-RPC lines into the server:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | npx tsx src/adapters/mcp/server.ts
```

You should see an `initialize` result followed by a `tools/list` result
carrying the four tools.

## Design notes

- **Pure JSON-RPC 2.0 over stdio** — no MCP framework dependency, matching the
  Gateway's "native primitives only" approach (`node:http`, no Express).
- **stdout is sacred** — it is the protocol channel; every diagnostic line goes
  to stderr. A stray `console.log` would corrupt the stream.
- **Graceful degradation** — if the Gateway is down, tool calls return an MCP
  `isError` result with a readable message instead of crashing the host's tool
  loop (the same contract the Hermes provider follows).
- **Clean shutdown** — in-flight tool calls are drained before exit, so a
  response is never truncated when the host closes stdin.

See [`docs/adapters/COMPARISON.md`](../../../docs/adapters/COMPARISON.md) for how
this adapter compares to the OpenClaw, Hermes, and Dify integrations.
