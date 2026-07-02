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

Integration testing requires agentgateway deployment 鈥?a deployment milestone, not a development one.
