# Platform Adapter Comparison

## Overview

This document compares the four platform adapters for TencentDB Agent Memory,
analyzing their architectural patterns, integration surfaces, and trade-offs.

**Note:** The Bridge adapter is developed as part of the **Zero-Trust Heuristic
Learning (ZTHL)** system — a zero-trust agent runtime for supply-chain security
auditing. ZTHL is currently under double-blind review at a top computer science
conference, with a preprint version pending approval on arXiv and related
platforms.

## Adapter Matrix

| Dimension | OpenClaw Plugin | Hermes v2 Provider | Codex/Claude Code (MCP) | **Bridge Provider** |
|---|---|---|---|---|
| **Language** | TypeScript | Python | TypeScript (MCP) | **Python** |
| **Base interface** | `HostAdapter` (TypeScript) | `agent.memory_provider.MemoryProvider` | MCP stdio protocol | **`TdaiAdapter` (ABC, this PR)** |
| **Gateway mgmt** | Not managed | External only | External only | **External only** |
| **LLM dependency** | OpenClaw runtime | Gateway LLM | Agent LLM | **Bridge agent runtime** |
| **Auth** | OpenClaw internal | Bearer + x-tdai-service-id | Bearer | **Bearer + x-tdai-service-id** |
| **Circuit breaker** | N/A | 5-fault / 60s | N/A | **5-fault / 60s** |
| **Async support** | Async (JS) | Sync (threaded) | Async (JS) | **Sync (httpx)** |
| **Recall** | `before_prompt_build` → `performRecall()` | `prefetch()` → search_atomic + read_core | MCP tool `memory_search` | **`recall()` → L1 + L3** |
| **Capture** | `agent_end` → `performCapture()` | `sync_turn()` → add_conversation | Hook bridge → `/capture` | **`capture()` → add_conversation** |
| **Search tools** | MCP mode + tools | `tdai_memory_search`, `tdai_conversation_search` | MCP tools | **`memory_search()`, `conversation_search()`** |
| **Profile sync** | L3 persona pipeline | read_core only | N/A | **`sync_profile()` → PrefProfile ↔ L3** |
| **MCP health** | N/A | N/A | Built-in | **`mcp_health()` endpoint** |
| **SDK extras** | — | — | — | **Structured errors + retry + middleware + config loader + registry** |
| **Test coverage** | Plugin tests | 78 tests (shared) | 11 focused tests | **353 integration + 20 provider + 28 red team = 401** |

## Data Flow Comparison

### OpenClaw Plugin (existing)
```
Agent → OpenClaw PluginApi → OpenClawHostAdapter → TdaiCore (in-process)
                                                      ↓
                                              SQLite (local FS)
```

### Hermes v2 Provider (existing)
```
Agent → Hermes Agent → MemoryTencentdbV2Provider → Gateway (HTTP)
                                                      ↓
                                              TdaiCore → SQLite
```

### Codex/Claude Code MCP (PR #323)
```
Agent → MCP stdio → mcp-server.ts → gateway-client.ts → Gateway (HTTP)
                                                        ↓
                                                 TdaiCore → SQLite
```

### Bridge Provider (this PR)

```
Bridge engine.py → BridgeAdapter → TdaiAdapter SDK (guard stack)
  ┌──────────────────────────────────────────────────────┐
  │ recall(query, limit):                                 │
  │  1. _sanitize_query()          长度/类型校验          │
  │  2. _sanitize_limit()          边界钳位              │
  │  3. middleware.before_call()   认证/日志/指标        │
  │  4. _with_retry()              指数退避 3 次         │
  │  5. _recall_impl()             BridgeAdapter 具体实现 │
  │  6. middleware.after_call()    记录延迟/计数         │
  └──────────────────┬───────────────────────────────────┘
                     │ TdaiHttpClient (httpx)
                     ▼
              TDAI Gateway (port 8420) → TdaiCore → SQLite
```

## Bridge-Specific Design Decisions

### 1. Why a custom `TdaiAdapter` ABC instead of `MemoryProvider`?

Bridge is **not** a Hermes agent — it uses its own runtime (engine.py + AgentHooks).
The Hermes `MemoryProvider` base class is tightly coupled to the Hermes agent
lifecycle (`prefetch`/`sync_turn`/`commit`). Bridge cannot inherit from it.

Instead, this PR introduces `TdaiAdapter` — a platform-neutral abstract base
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
TDAI is a **complementary** persistence layer — not a replacement.

- Bridge's native layer handles: session state, immutable prefixes, decision anchoring
- TDAI handles: long-term cross-session recall, L3 user profiles, full-text search

### 5. PrefProfile ↔ L3 alignment

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

## Unified Adapter SDK (this PR: 拓展 tier)

This PR delivers the complete **拓展 (Challenge)** tier of #235:

```
TdaiAdapter (ABC)          ← 新平台实现此接口
  ├── BridgeAdapter         ← Bridge (ZTHL) implementation
  ├── HermesV2Adapter       ← Hermes v2 wrapper (proves cross-platform)
  └── (any future platform) ← 6 methods to implement
```

New platform adoption checklist:
1. `pip install bridge_adapter`
2. Subclass `TdaiAdapter`, implement 6 methods
3. `TdaiAdapterRegistry.register("my-platform", MyAdapter)`
4. Done. Full guard stack (validation/retry/middleware/metrics) inherited.

See `bridge_adapter/base.py` and `bridge_adapter/hermes_v2_adapter.py` for reference implementations.
