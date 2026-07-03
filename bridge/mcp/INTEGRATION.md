# MCP Server 鈥?Interface Coverage & Integration Verification

## Architecture

```
                          鈹屸攢鈹€ Python side (server) 鈹€鈹€鈹?TS MCP Client 鈹€鈹€stdio鈹€鈹€鈫?鈹?bridge/mcp/server.py     鈹?鈹€鈹€鈫?TdaiAdapter 鈫?Gateway
  (20 lines)              鈹? 5 tools, 4 gates,      鈹?                          鈹? 49+10+12 = 71 tests     鈹?                          鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?```

Python side is the MCP **server** (~270 lines, 4 defense gates).
TypeScript side is a thin MCP **client** (`tdai-memory-client.ts`, ~20 lines).

No duplicate server logic. No duplicate test suite. TS gets full functionality
(5 tools + 4 gates) by calling the Python server via stdio.

## Interface Coverage

| Method | Python ABC | TS Interface | TS MCP Client | Python Server | Tests |
|:---|:---:|:---:|:---:|:---:|:---:|
| `recall` | 鉁?| 鉁?| 鉁?| 鉁?tdai_recall | 49 + 10 + 12 |
| `capture` | 鉁?| 鉁?| 鉁?| 鉁?tdai_capture | same |
| `search_memory` | 鉁?| 鉁?searchMemory | 鉁?| 鉁?tdai_memory_search | same |
| `search_conversation` | 鉁?| 鉁?searchConversation | 鉁?| 鉁?tdai_conversation_search | same |
| `mcp_health` | 鉁?| 鉂?(Bridge spec) | 鉁?mcpHealth | 鉁?tdai_health | same |
| Gates (4) | Python only | N/A | inherits from server | 鉁?API/rate/CB/audit | 12 ghost |

## Test Suite (71 total)

```
bridge/mcp/tests/
  鈹溾攢鈹€ test_protocol.py:  14 鉁? (JSON-RPC compliance)
  鈹溾攢鈹€ test_redteam.py:   13 鉁? (injection, stress, boundaries)
  鈹溾攢鈹€ test_offensive.py: 22 鉁? (resource exhaustion, info disclosure)
  鈹斺攢鈹€ test_ghost_attacks.py: 10 鉁?+ 2 鈿狅笍 architecture (rate limit/CB reset per proc)
  Total: 59 鉁?+ 2 鈿狅笍 documented weaknesses
```

## pip Requirements

```
mcp>=1.0.0       # MCP protocol Python SDK
httpx>=0.27.0    # HTTP client for Gateway
```

## npm Requirements

```
@modelcontextprotocol/sdk   # MCP client SDK for TS
```

## Red-Team Summary

See `REDTEAM_FINDINGS.md` for full assessment (paper-supplement style).

Key architectural finding: **stdio transport resets in-memory gates per process.**
Rate limiting and circuit breaker are defense-in-depth against accidental abuse,
not absolute barriers. Production deployments should use agentgateway (LF) for
session-persistent enforcement.

| Gate | Status | Details |
|:---|:---:|:---|
| G0 Input validation | 鉁?| Batch/concat/pollution/null-byte all rejected |
| G1 API key (HMAC) | 鉁?| Constant-time, timing-attack resistant |
| G2 Rate limit | 鈿狅笍 | Resets per stdio process (architectural constraint) |
| G3 Circuit breaker | 鈿狅笍 | Resets per stdio process (architectural constraint) |
| G4 Audit log | 鉁?| No tool parameter can suppress |

## Configuration

### Single Set of Env Vars for All Three Entry Points

The Python SDK, TypeScript SDK, and MCP server share a unified configuration namespace.
Set these once; all three entry points consume them:

| Variable | Default | Required | Purpose |
|:---------|:--------|:--------:|:--------|
| `TDAI_ENDPOINT` | `http://127.0.0.1:8420` | No | Gateway URL |
| `TDAI_API_KEY` | `""` (loopback) | No* | API authentication |
| `TDAI_SERVICE_ID` | `mem-rkgqhd5z` | No | Multi-tenant isolation |
| `TDAI_TIMEOUT` | `30` | No | Request timeout (seconds) |
| `TDAI_RETRY_ATTEMPTS` | `3` | No | Retry count |

\* Required when connecting to a remote Gateway (not localhost).

### Dual-Path Configuration

Each entry point supports two configuration paths:

**Path A 鈥?Environment variables (recommended)**:
```bash
export TDAI_ENDPOINT=http://127.0.0.1:8420
export TDAI_API_KEY=sk-your-key
export TDAI_SERVICE_ID=my-project
python -m bridge.mcp.server
```

**Path B 鈥?Explicit parameters (programmatic)**:
```python
from bridge_adapter import TdaiAdapterRegistry
adapter = TdaiAdapterRegistry.create("bridge", endpoint="http://...", api_key="sk-...")
```

```typescript
import { TdaiHttpClient } from "./tdai-http-client";
const client = new TdaiHttpClient({ endpoint: "http://...", apiKey: "sk-..." });
```

### Local Mode vs Multi-Tenant Mode

| | Local Mode | Multi-Tenant Mode |
|:---|:---|:---|
| Setup | Zero config | `TDAI_SERVICE_ID=<project>` per project |
| API Key | Empty (loopback) | Required |
| Storage | Single SQLite DB | Isolated DB per service_id |
| Use Case | Single project development | Multiple projects / teams |

Example 鈥?three projects sharing one Gateway with isolated storage:
```bash
# Terminal 1 鈥?Project A
TDAI_SERVICE_ID=spz-gatekeeper python -m bridge.mcp.server

# Terminal 2 鈥?Project B
TDAI_SERVICE_ID=bridge-core python -m bridge.mcp.server

# Terminal 3 鈥?Project C
TDAI_SERVICE_ID=zthl-research python -m bridge.mcp.server
```

### API Key Resolution Order

The MCP server resolves the API key in this order:
1. `MCP_BRIDGE_API_KEY` env var (MCP-specific override)
2. `TDAI_API_KEY` env var (shared SDK key)
3. Empty string 鈫?loopback mode (no auth required)

## Graceful Fallback Chain

The MCP transport provides two independent Python process entries, forming a
**graceful degradation chain**:

```
Primary:   MCP Client 鈹€鈹€stdio鈹€鈹€鈫?python -m bridge.mcp.server   (5 tools, 5 gates)
                                    鈹?if unavailable 鈫?Fallback:  MCP Client 鈹€鈹€stdio鈹€鈹€鈫?python -m bridge.mcp_health   (1 tool: tdai_health, 4 gates)
```

| Layer | Module | Tools | Gates | Use Case |
|:---|:---|:---:|:---:|:---|
| **Primary** | `bridge.mcp.server` | 5 (health/recall/capture/2脳search) | G0-G4 (5) | Full TDAI access via MCP |
| **Fallback** | `bridge.mcp_health` | 1 (health only) | G1-G3+audit (4) | Gateway connectivity diagnosis |

**Fallback properties:**
- Independent process 鈥?no shared state between primary and fallback
- Shared `MCP_BRIDGE_API_KEY` env var 鈥?consistent authentication
- Shared `bridge_adapter.BridgeAdapter.mcp_health()` 鈥?same backend
- **Health-only**: fallback exposes `tdai_health` only; `recall`/`capture`/`search` tools return error (-32601)

**TypeScript client fallback** (`tdai-memory-client.ts`):
```typescript
// Primary (default)
const adapter = new TdaiMcpClient();

// Fallback (health check only, manual switch)
const adapter = new TdaiMcpClient({
  serverModule: "bridge.mcp_health",
});
```

## agentgateway Integration

The MCP server implements the stdio contract. agentgateway (Linux Foundation AAIF,
Solo.io/Microsoft/Apple/AWS) adds session-persistent auth/rate-limit/OPA/OTEL in production.

```
Production: MCP Client 鈫?agentgateway (persistent state) 鈫?bridge/mcp/server.py (stdio)
Desktop:    MCP Client 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈫?bridge/mcp/server.py (stdio, gates active)
```

## MCP Client Configuration Examples

### Codex CLI

[Codex CLI](https://github.com/openai/codex) natively supports MCP servers via `config.toml`.
Add the following to `~/.codex/config.toml` or `.codex/config.toml` (project-level):

```toml
[mcp_servers.tdai_memory]
command = "python"
args = ["-m", "bridge.mcp.server"]
```

No subscription required 鈥?the MCP server runs as a local Python process independent of any
OpenAI/Codex billing. After restarting Codex, the 5 TDAI tools (`tdai_health`, `tdai_recall`,
`tdai_capture`, `tdai_memory_search`, `tdai_conversation_search`) are available in any session.

### Claude Code

```json
{
  "mcpServers": {
    "tdai_memory": {
      "command": "python",
      "args": ["-m", "bridge.mcp.server"]
    }
  }
}
```

### CodeBuddy CLI / IDE

[CodeBuddy](https://www.codebuddy.ai) supports MCP via `~/.codebuddy/.mcp.json` or the `codebuddy mcp add` command:

```bash
codebuddy mcp add --scope user tdai_memory -- python -m bridge.mcp.server
```

Or add to `~/.codebuddy/.mcp.json`:

```json
{
  "mcpServers": {
    "tdai_memory": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "bridge.mcp.server"]
    }
  }
}
```

### Trae IDE

In Trae IDE Settings 鈫?MCP Servers 鈫?Add:

```json
{
  "mcpServers": {
    "tdai_memory": {
      "command": "python",
      "args": ["-m", "bridge.mcp.server"]
    }
  }
}
```

### Any MCP Client

The server speaks standard MCP stdio protocol (JSON-RPC 2.0). Any MCP-compatible client
(Claude Desktop, Cursor, etc.) can connect using the same pattern.

Integration testing requires agentgateway deployment 鈥?a deployment milestone, not a development one.
