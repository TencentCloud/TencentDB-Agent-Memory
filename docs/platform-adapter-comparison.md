# Platform Adapter Comparison

## Overview

This document compares the six platform adapter approaches for TencentDB Agent Memory,
analyzing their architectural patterns, integration surfaces, and trade-offs.

**Note:** The Bridge adapter is developed as part of the **Zero-Trust Heuristic
Learning (ZTHL)** system - a zero-trust agent runtime for supply-chain security
auditing. ZTHL is currently under double-blind review at a top computer science
conference, with a preprint version pending approval on arXiv and related
platforms.

## Adapter Matrix

Six approaches spanning the TDAI adapter ecosystem:

| Dimension | OpenClaw Plugin | Hermes v2 Provider | Codex/Claude Code/OpenCode<br>(PR #323, NianJiuZst) | coder-mtj 6-Platform<br>(PR #359) | **Bridge Provider<br>(this PR)** | **Bridge MCP Transport<br>(optional, this PR)** |
|---|---|---|---|---|---|---|---|---|
| **Language** | TypeScript | Python | TypeScript | TypeScript (+ Python SDK) | **Python** | **Python server + TS client** |
| **Base interface** | `HostAdapter` (TypeScript) | `agent.memory_provider.MemoryProvider` | Shared hook-bridge + mcp-server.ts | `MemoryPlatformAdapter` interface | **`TdaiAdapter` (ABC)** | **MCP stdio protocol** |
| **Platforms** | OpenClaw | Hermes | Codex + Claude Code + OpenCode | Codex + Claude Code + Dify + MCP + REST + Standalone | **Bridge (ZTHL)** | **Any MCP host** |
| **Circuit breaker** | N/A | 5-fault / 60s | N/A | 3-state + exponential backoff | **5-fault / 60s** | **10-fault / 60s (G3)** |
| **Rate limiting** | N/A | N/A | N/A | N/A | **N/A** | **Sliding window 60/60s (G2)** |
| **Audit logging** | N/A | N/A | N/A | N/A | **N/A** | **All calls logged WARNING (G4)** |
| **Retry** | Platform native | Platform native | None | Exponential backoff + jitter | **Exponential backoff (3 attempts)** | **Inherited via adapter** |
| **MCP framework dep** | N/A | N/A | @modelcontextprotocol/sdk | @modelcontextprotocol/sdk | **N/A** | **None (pure JSON-RPC 2.0)** |
| **Defense gates** | Platform native | Platform native | None | None | **Retry + CB + middleware** | **5-layer: Schema/Key/Rate/CB/Audit** |
| **SDK abstraction** | Interface only | Provider base class | Shared infrastructure only | Interface + implementations | **ABC + 3 implementations + registry + middleware** | **Inherited via adapter** |
| **TS SDK** | Native | N/A | Shared gateway-client + hook-bridge + mcp-server | Shared gateway client + Dify OpenAPI generator | **MemoryAdapter interface** | **BaseMemoryAdapter + TdaiHttpClient** |
| **Test coverage** | Plugin tests | 78 tests | 4 test files | 353 tests (chaos/contract/e2e/security/unit) | **353 integration + 20 provider + 28 red team = 401** | **14 protocol + 13 redteam + 22 offensive + 12 ghost = 59 + 2?** |

## Data Flow Comparison

### OpenClaw Plugin (existing)
```
Agent -> OpenClaw PluginApi -> OpenClawHostAdapter -> TdaiCore (in-process)
                                                        v
                                                SQLite (local FS)
```

### Hermes v2 Provider (existing)
```
Agent -> Hermes Agent -> MemoryTencentdbV2Provider -> Gateway (HTTP)
                                                        v
                                                TdaiCore -> SQLite
```

### Codex/Claude Code/OpenCode (PR #323, NianJiuZst)
```
Agent -> MCP stdio -> mcp-server.ts -> gateway-client.ts -> Gateway (HTTP)
                                                            v
                                                     TdaiCore -> SQLite
```
Emphasis on platform-specific lifecycle hooks and shared TypeScript infrastructure.
Approach: "prove the patterns first, extract SDK later."

### coder-mtj 6-Platform (PR #359)
```
Agent -> per-platform adapter -> gateway-client.ts -> Gateway (HTTP)
                                                        v
                                                TdaiCore -> SQLite
```
Emphasis on maximum platform coverage (6), runtime resilience (3-state CB, retry),
and comprehensive test categories (chaos, contract, e2e, security, unit).

### Bridge Provider (this PR)

```
Bridge engine.py -> BridgeAdapter -> TdaiAdapter SDK (guard stack)
  +--------------------------------------------------------------+
  | recall(query, limit):                                        |
  | 1. _sanitize_query()          length/type validation         |
  | 2. _sanitize_limit()          boundary clamping              |
  | 3. middleware.before_call()   auth/logging/metrics           |
  | 4. _with_retry()              exponential backoff (3 tries)  |
  | 5. _recall_impl()             BridgeAdapter implementation   |
  | 6. middleware.after_call()    record latency/counts          |
  +--------------------------------------------------------------+
                     | TdaiHttpClient (httpx)
                     v
              TDAI Gateway (port 8420) -> TdaiCore -> SQLite
```

### Bridge MCP Transport (optional, this PR)

```
MCP Host (Claude Desktop / Codex / CodeBuddy / Trae / Cursor)
     | @modelcontextprotocol/sdk -> StdioClientTransport
     v
  bridge/mcp/server.py  (JSON-RPC 2.0, no MCP framework)
  +-- G0: JSON-RPC schema validation
  +-- G1: API Key (HMAC)
  +-- G2: Rate limit (sliding window, 60/60s)
  +-- G3: Circuit breaker (10 fail -> 60s cooldown)
  +-- G4: Audit log
      +-- Tool handlers -> BridgeAdapter -> TdaiAdapter SDK -> Gateway
```

The MCP transport is a **complementary access path** - not a replacement - for the Bridge adapter.
It enables MCP-native agent hosts to call the same TdaiAdapter SDK through the stdio protocol,
with five integrated defense gates active regardless of deployment mode.

A lightweight health-only fallback (`bridge.mcp_health`, 1 tool, 4 gates) exists for cases
where the full MCP server is unavailable - both share `MCP_BRIDGE_API_KEY` and the same
`BridgeAdapter.mcp_health()` backend, forming a graceful degradation chain.

## Bridge-Specific Design Decisions

### 1. Why a custom `TdaiAdapter` ABC instead of `MemoryProvider`?

Bridge is **not** a Hermes agent - it uses its own runtime (engine.py + AgentHooks).
The Hermes `MemoryProvider` base class is tightly coupled to the Hermes agent
lifecycle (`prefetch`/`sync_turn`/`commit`). Bridge cannot inherit from it.

Instead, this PR introduces `TdaiAdapter` - a platform-neutral abstract base
class that any agent runtime can implement. It follows the same operational
patterns (recall/capture/search) but without Hermes-specific lifecycle coupling.

### 2. What does the SDK provide beyond the interface?

| Feature | Location | Purpose |
|---|---|---|
| **Parameter validation** | `_sanitize_query/limit/content` | Type check + truncation (100K/1M) |
| **Structured errors** | `TdaiConnectionError` etc. | Catch specific failures, not bare `Exception` |
| **Exponential backoff** | `_with_retry()` | 3 attempts, 0.5s base + jitter |
| **Middleware hooks** | `TdaiMiddleware` ABC | `before_call`/`after_call`/`on_error` |
| **Built-in metrics** | `TdaiMetricsMiddleware` | Call counts + avg latency per method |
| **Config from env** | `TdaiConfig.from_env()` | Standard `TDAI_*` env var loader |
| **Registry** | `TdaiAdapterRegistry` | Name-based adapter lookup + `health_all()` |

### 3. Why both sync and async paths?

Bridge's `offload_compact` happens on async boundaries (during checkpoint
compression), while `build_profile_from_log` runs synchronously at session
end. The provider supports both paths with the same `TdaiHttpClient`.

### 4. How does this relate to Bridge's native memory?

Bridge has its own memory layer (checkpoint/frozen/anchor/decision).
TDAI is a **complementary** persistence layer - not a replacement.

- Bridge's native layer handles: session state, immutable prefixes, decision anchoring
- TDAI handles: long-term cross-session recall, L3 user profiles, full-text search

### 5. PrefProfile -> L3 alignment

Bridge builds a `PrefProfile` from human preference logs (language preference,
audit depth, safety sensitivity). The `sync_profile()` method aligns this
with TDAI's L3 core, enabling cross-session preference persistence.

## Approach Comparison Summary

Each PR takes a distinct approach to the same problem (cross-platform TDAI access):

| PR | Strategy | Strength |
|:---|---|:---|
| #323 (NianJiuZst) | **Platform lifecycle first** - integrate deeply with 3 specific platforms via shared infrastructure | Deep platform integration, proven hook/MCP patterns |
| #359 (coder-mtj) | **Platform breadth first** - cover 6 platforms with comprehensive test infrastructure | Maximum coverage, runtime resilience, test variety |
| **#339 (this PR)** | **Abstraction first** - define a formal ABC/interface, then provide concrete implementations + optional MCP transport + defense gates | Cross-language SDK, defense-in-depth, pluggable architecture |

These are complementary strategies. All three can learn from each other:
- Platform lifecycle patterns from #323
- Test infrastructure and resilience from #359
- SDK abstraction and defense gates from this PR

## Platform Adoption Impact

| Platform | Lines of adapter code | Dependencies | Setup time |
|---|---|---|---|
| OpenClaw | ~500 (plugin) | OpenClaw SDK | 1 min |
| Hermes v2 | ~350 (Provider) | tencentdb_agent_memory SDK | 2 min |
| Codex MCP | ~600 (shared layer) | Node.js, tsx | 3 min |
| **Bridge** | **~400 (Provider + client)** | **httpx** | **1 min** |

## Unified Adapter SDK (this PR)

This PR delivers a complete SDK tier for #235:

```
TdaiAdapter (ABC)          -> new platform implements this interface
   +-- BridgeAdapter          -> Bridge (ZTHL) implementation
   +-- HermesV2Adapter        -> Hermes v2 wrapper (proves cross-platform)
   +-- (any future platform)  -> 6 methods to implement
```

New platform adoption checklist:
1. `pip install bridge_adapter`
2. Subclass `TdaiAdapter`, implement 6 methods
3. `TdaiAdapterRegistry.register("my-platform", MyAdapter)`
4. Done. Full guard stack (validation/retry/middleware/metrics) inherited.

See `bridge_adapter/base.py` and `bridge_adapter/hermes_v2_adapter.py` for reference implementations.
