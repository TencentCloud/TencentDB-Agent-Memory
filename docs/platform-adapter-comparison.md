# Platform Adapter Comparison

## Overview

This document compares the four platform adapters for TencentDB Agent Memory,
analyzing their architectural patterns, integration surfaces, and trade-offs.

**Note:** The Bridge adapter is developed as part of the **Zero-Trust Heuristic
Learning (ZTHL)** system 鈥?a zero-trust agent runtime for supply-chain security
auditing. ZTHL is currently under double-blind review at a top computer science
conference, with a preprint version pending approval on arXiv and related
platforms.

## Adapter Matrix

| Dimension | OpenClaw Plugin | Hermes v2 Provider | Codex/Claude Code (MCP) | **Bridge Provider** | **Bridge MCP Transport (optional)** |
|---|---|---|---|---|---|---|
| **Language** | TypeScript | Python | TypeScript (MCP) | **Python** | **Python server + TS client** |
| **Base interface** | `HostAdapter` (TypeScript) | `agent.memory_provider.MemoryProvider` | MCP stdio protocol | **`TdaiAdapter` (ABC, this PR)** | **MCP stdio protocol** |
| **Gateway mgmt** | Not managed | External only | External only | **External only** | **External only** |
| **LLM dependency** | OpenClaw runtime | Gateway LLM | Agent LLM | **Bridge agent runtime** | **MCP Host (any)** |
| **Auth** | OpenClaw internal | Bearer + x-tdai-service-id | Bearer | **Bearer + x-tdai-service-id** | **API Key (HMAC, G1)** |
| **Circuit breaker** | N/A | 5-fault / 60s | N/A | **5-fault / 60s** | **10-fault / 60s (G3)** |
| **Rate limiting** | N/A | N/A | N/A | **N/A** | **Sliding window 60/60s (G2)** |
| **Audit logging** | N/A | N/A | N/A | **N/A** | **All calls logged WARNING (G4)** |
| **Async support** | Async (JS) | Sync (threaded) | Async (JS) | **Sync (httpx)** | **Sync (stdio)** |
| **Recall** | `before_prompt_build` 鈫?`performRecall()` | `prefetch()` 鈫?search_atomic + read_core | MCP tool `memory_search` | **`recall()` 鈫?L1 + L3** | **`tdai_recall` MCP tool** |
| **Capture** | `agent_end` 鈫?`performCapture()` | `sync_turn()` 鈫?add_conversation | Hook bridge 鈫?`/capture` | **`capture()` 鈫?add_conversation** | **`tdai_capture` MCP tool** |
| **Search tools** | MCP mode + tools | `tdai_memory_search`, `tdai_conversation_search` | MCP tools | **`memory_search()`, `conversation_search()`** | **`tdai_memory/conversation_search` tools** |
| **Profile sync** | L3 persona pipeline | read_core only | N/A | **`sync_profile()` 鈫?PrefProfile 鈫?L3** | **Inherited via adapter** |
| **MCP health** | N/A | N/A | Built-in | **`mcp_health()` endpoint** | **`tdai_health` tool (G0-G4 active)** |
| **Defense gates** | Platform native | Platform native | None | **Retry + CB + middleware** | **5-layer: Schema/Key/Rate/CB/Audit** |
| **SDK extras** | 鈥?| 鈥?| 鈥?| **Structured errors + retry + middleware + config loader + registry + BufferedAdapter** | **Inherited via TdaiAdapter** |
| **TS SDK extras** | 鈥?| 鈥?| 鈥?| **MemoryAdapter interface only** | **BaseMemoryAdapter + TdaiHttpClient (retry+middleware+cache+7 error types)** |
| **Test coverage** | Plugin tests | 78 tests (shared) | 11 focused tests | **353 integration + 20 provider + 28 red team = 401** | **14 protocol + 13 redteam + 22 offensive + 12 ghost = 59 + 2 鈿狅笍** |

## Data Flow Comparison

### OpenClaw Plugin (existing)
```
Agent 鈫?OpenClaw PluginApi 鈫?OpenClawHostAdapter 鈫?TdaiCore (in-process)
                                                      鈫?                                              SQLite (local FS)
```

### Hermes v2 Provider (existing)
```
Agent 鈫?Hermes Agent 鈫?MemoryTencentdbV2Provider 鈫?Gateway (HTTP)
                                                      鈫?                                              TdaiCore 鈫?SQLite
```

### Codex/Claude Code MCP (PR #323)
```
Agent 鈫?MCP stdio 鈫?mcp-server.ts 鈫?gateway-client.ts 鈫?Gateway (HTTP)
                                                        鈫?                                                 TdaiCore 鈫?SQLite
```

### Bridge Provider (this PR)

```
Bridge engine.py 鈫?BridgeAdapter 鈫?TdaiAdapter SDK (guard stack)
  鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?  鈹?recall(query, limit):                                 鈹?  鈹? 1. _sanitize_query()          闀垮害/绫诲瀷鏍￠獙          鈹?  鈹? 2. _sanitize_limit()          杈圭晫閽充綅              鈹?  鈹? 3. middleware.before_call()   璁よ瘉/鏃ュ織/鎸囨爣        鈹?  鈹? 4. _with_retry()              鎸囨暟閫€閬?3 娆?        鈹?  鈹? 5. _recall_impl()             BridgeAdapter 鍏蜂綋瀹炵幇 鈹?  鈹? 6. middleware.after_call()    璁板綍寤惰繜/璁℃暟         鈹?  鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                     鈹?TdaiHttpClient (httpx)
                     鈻?              TDAI Gateway (port 8420) 鈫?TdaiCore 鈫?SQLite
```

### Bridge MCP Transport (optional, this PR)

```
MCP Host (Claude Desktop / Codex / ...)
    鈹?@modelcontextprotocol/sdk 鈫?StdioClientTransport
    鈻?bridge/mcp/server.py  (JSON-RPC 2.0, no MCP framework)
  鈹溾攢 G0: JSON-RPC schema validation
  鈹溾攢 G1: API Key (HMAC)
  鈹溾攢 G2: Rate limit (sliding window, 60/60s)
  鈹溾攢 G3: Circuit breaker (10 fail 鈫?60s cooldown)
  鈹溾攢 G4: Audit log
  鈹斺攢 Tool handlers 鈫?BridgeAdapter 鈫?TdaiAdapter SDK 鈫?Gateway
```

The MCP transport is a **complementary access path** 鈥?not a replacement 鈥?for the Bridge adapter.
It enables MCP-native agent hosts to call the same TdaiAdapter SDK through the stdio protocol,
with five integrated defense gates active regardless of deployment mode.

A lightweight health-only fallback (`bridge.mcp_health`, 1 tool, 4 gates) exists for cases
where the full MCP server is unavailable 鈥?both share `MCP_BRIDGE_API_KEY` and the same
`BridgeAdapter.mcp_health()` backend, forming a graceful degradation chain.

## Bridge-Specific Design Decisions

### 1. Why a custom `TdaiAdapter` ABC instead of `MemoryProvider`?

Bridge is **not** a Hermes agent 鈥?it uses its own runtime (engine.py + AgentHooks).
The Hermes `MemoryProvider` base class is tightly coupled to the Hermes agent
lifecycle (`prefetch`/`sync_turn`/`commit`). Bridge cannot inherit from it.

Instead, this PR introduces `TdaiAdapter` 鈥?a platform-neutral abstract base
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
TDAI is a **complementary** persistence layer 鈥?not a replacement.

- Bridge's native layer handles: session state, immutable prefixes, decision anchoring
- TDAI handles: long-term cross-session recall, L3 user profiles, full-text search

### 5. PrefProfile 鈫?L3 alignment

Bridge builds a `PrefProfile` from human preference logs (language preference,
audit depth, safety sensitivity). The `sync_profile()` method aligns this
with TDAI's L3 core, enabling cross-session preference persistence.

## Platform Adoption Impact

| Platform | Lines of adapter code | Dependencies | Setup time |
|---|---|---|---|
| OpenClaw | ~500 (plugin) | OpenClaw SDK | 1 min |
| Hermes v2 | ~350 (Provider) | tencentdb_agent_memory SDK | 2 min |
| Codex MCP | ~600 (shared layer) | Node.js, tsx | 3 min |
| **Bridge** | **~400 (Provider + client)** | **httpx** | **1 min** |

## Unified Adapter SDK (this PR: 鎷撳睍 tier)

This PR delivers the complete **鎷撳睍 (Challenge)** tier of #235:

```
TdaiAdapter (ABC)          鈫?鏂板钩鍙板疄鐜版鎺ュ彛
  鈹溾攢鈹€ BridgeAdapter         鈫?Bridge (ZTHL) implementation
  鈹溾攢鈹€ HermesV2Adapter       鈫?Hermes v2 wrapper (proves cross-platform)
  鈹斺攢鈹€ (any future platform) 鈫?6 methods to implement
```

New platform adoption checklist:
1. `pip install bridge_adapter`
2. Subclass `TdaiAdapter`, implement 6 methods
3. `TdaiAdapterRegistry.register("my-platform", MyAdapter)`
4. Done. Full guard stack (validation/retry/middleware/metrics) inherited.

See `bridge_adapter/base.py` and `bridge_adapter/hermes_v2_adapter.py` for reference implementations.
