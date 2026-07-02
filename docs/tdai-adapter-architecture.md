# TdaiAdapter SDK 鈥?Architecture

> **Note**: This is a clean SDK-focused copy of the full architecture document.
> The original (with Bridge-internal details) is at `bridge/docs/TDAI-ARCHITECTURE.md` in the Bridge repository.

## Overview

**TdaiAdapter** is a platform-neutral Python SDK for TencentDB Agent Memory v2 Gateway API.
It provides a unified interface (`TdaiAdapter` ABC) that any agent runtime can implement
to connect to TDAI Gateway for recall, capture, and search operations.

```
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?                    Any Platform                             鈹?鈹? engine.py / agent hooks 鈫?BridgeAdapter / CustomAdapter    鈹?鈹?                    鈹?                                       鈹?鈹?                    鈻?                                       鈹?鈹? 鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹愨攤
鈹? 鈹?TdaiAdapter SDK (bridge_adapter.base)                   鈹傗攤
鈹? 鈹? recall(query, limit)                                   鈹傗攤
鈹? 鈹?  鈹溾攢 _sanitize_query()      100K truncation + type     鈹傗攤
鈹? 鈹?  鈹溾攢 _sanitize_limit()       [1, 1000] clamping        鈹傗攤
鈹? 鈹?  鈹溾攢 middleware.before()     metrics / auth / logging  鈹傗攤
鈹? 鈹?  鈹溾攢 _with_retry()           3 attempts, exp backoff   鈹傗攤
鈹? 鈹?  鈹?  鈹斺攢 _recall_impl()      platform implementation  鈹傗攤
鈹? 鈹?  鈹溾攢 middleware.after()      record latency + counts  鈹傗攤
鈹? 鈹?  鈹斺攢 graceful degradation    exception 鈫?safe empty   鈹傗攤
鈹? 鈹?                                                       鈹傗攤
鈹? 鈹? BufferedAdapter: optional mixin, local JSONL buffer  鈹傗攤
鈹? 鈹? TdaiAdapterRegistry: name-based lookup + health_all() 鈹傗攤
鈹? 鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹樷攤
鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹尖攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                        鈹?TdaiHttpClient (httpx, sync)
                        鈻?                 TDAI Gateway (port 8420) 鈫?TdaiCore 鈫?SQLite
```

## SDK Components

### 1. `TdaiAdapter` (ABC) 鈥?`bridge_adapter/base.py`

Abstract base class. Subclasses implement 4 internal methods:

| Public API | Internal method | Description |
|:---|:---|:---|
| `recall(query, limit)` | `_recall_impl(query, limit)` | Cross-session memory 鈫?prepend_context |
| `capture(user, assistant, session_id)` | `_capture_impl(...)` | Write conversation turn to L0 |
| `search_memory(query, limit)` | `_search_memory_impl(...)` | Search L1 atomic memories |
| `search_conversation(query, limit)` | `_search_conversation_impl(...)` | Search L0 conversation history |

Each public method shares the same guard stack:
1. **Sanitize** 鈥?type check, length truncation (100K chars), limit clamping [1, 1000]
2. **Middleware.before()** 鈥?metrics, auth, logging hooks
3. **Retry loop** 鈥?exponential backoff (3 attempts, base 0.5s, jitter 10%)
4. **Implementation** 鈥?subclass-specific logic
5. **Middleware.after()** 鈥?record latency, call count
6. **Graceful degradation** 鈥?on exception, return safe empty defaults

### 2. `BridgeAdapter` 鈥?`bridge_adapter/__init__.py`

Reference implementation using httpx. Connects to TDAI Gateway REST API.

### 3. `TdaiHttpClient` 鈥?`bridge_adapter/client.py`

Thin httpx wrapper for 7 Gateway endpoints:
- `GET /health`
- `POST /v2/conversation/add`
- `POST /v2/conversation/query`
- `POST /v2/atomic/search`
- `POST /v2/scenario/ls`
- `POST /v2/core/read`
- `POST /v2/core/update`

### 4. `BufferedAdapter` 鈥?`bridge_adapter/base.py`

Optional mixin that replaces per-call `capture()` with local JSONL buffering.
Flushes to Gateway at buffer_size threshold or on `shutdown()` (with atexit guarantee).

### 5. `TdaiAdapterRegistry` 鈥?`bridge_adapter/base.py`

Name-based adapter class registry. Supports `register()`, `get()`, `list()`, `create()`, and `health_all()` (aggregate health check across all registered adapters).

### 6. `HermesV2Adapter` 鈥?`bridge_adapter/hermes_v2_adapter.py`

Cross-platform reference implementation using the official Hermes Python SDK.
Demonstrates that `TdaiAdapter` can wrap existing SDKs.

## Key Design Decisions

| Decision | Rationale |
|:---|:---|
| **TdaiAdapter ABC** instead of Hermes MemoryProvider | Hermes MemoryProvider is tightly coupled to Hermes lifecycle (`prefetch`/`sync_turn`). TdaiAdapter is platform-neutral |
| **httpx sync client** | Sync is simpler to integrate across diverse runtimes. Async wrappers can be added at the platform level |
| **Sanitize + retry + middleware** in base class | Every platform gets parameter safety and resilience for free. No opt-in needed |
| **Structured errors** | `TdaiConnectionError` / `TdaiAuthError` / `TdaiTimeoutError` / `TdaiRateLimitError` / `TdaiValidationError` 鈥?callers catch specific failures |
| **Exponential backoff** (3 attempts, 0.5s base) | Transient failures auto-retry. Auth and validation errors propagate immediately |
| **Middleware hooks** | `before_call` / `after_call` / `on_error` 鈥?for metrics, auth, logging. Built-in `TdaiMetricsMiddleware` |
| **TdaiConfig.from_env()** | Standard config from `TDAI_*` env vars |
| **Local + Cloud dual path** | Default `http://127.0.0.1:8420` (local Gateway). Set `TDAI_ENDPOINT` to cloud URL for cloud mode |
| **Multi-tenant isolation** | `x-tdai-service-id` header on every request. Set `TDAI_SERVICE_ID` per project |
| **BufferedAdapter** | Optional local JSONL buffer. Captures stored locally, flush at buffer_size or session end |
| **Session-level recall cache** | SHA256(query) 鈫?cached per adapter lifetime. Prevents prompt prefix cache degradation (#120) |
| **Circuit breaker** (5-fault / 60s) | Prevents cascading failures when Gateway is down |
| **Graceful degradation** | Gateway unreachable 鈫?operations return safe empty defaults |
| **SHA256SUMS integrity** | Release verification. `python -m bridge_adapter.integrity --check` |

## Cross-Language SDK

| Language | Interface | Install | File | Tests |
|:---|:---|:---|:---|:---:|
| **Python** | `TdaiAdapter` (ABC) | `pip install bridge_adapter` | `bridge_adapter/base.py` | 37 red-team + 20 provider |
| **TypeScript** | `MemoryAdapter` (interface) | `npm install @tencentdb-agent-memory/memory-tencentdb` | `src/core/types.ts` | 19 red-team |
| **MCP (Python server + TS client)** | MCP stdio protocol | `pip install bridge_adapter` + `npm install @modelcontextprotocol/sdk` | `bridge/mcp/server.py` + `bridge/mcp/tdai-memory-client.ts` | 59 + 2 architecture warnings |

Python and TypeScript define the same contract: `recall` / `capture` / `searchMemory` / `searchConversation`
with parameter validation and graceful degradation.

The **MCP transport layer** adds a lightweight stdio bridge for environments that prefer the
Model Context Protocol 鈥?no server-side MCP framework dependency, minimal surface area.

## MCP Transport Layer

The MCP transport is an **optional** access path to the TdaiAdapter SDK, designed for
MCP-native agent hosts (Claude Desktop, Codex, etc.).

```
MCP Client (TypeScript, @modelcontextprotocol/sdk)
    鈹?stdio
    鈻?bridge/mcp/server.py (Python, no MCP framework dependency)
  鈹溾攢 Gate 0: JSON-RPC 2.0 schema validation
  鈹溾攢 Gate 1: API Key authentication (HMAC constant-time)
  鈹溾攢 Gate 2: Sliding window rate limit (60 req/60s)
  鈹溾攢 Gate 3: Circuit breaker (10 failures 鈫?60s cooldown)
  鈹溾攢 Gate 4: Audit logging (all calls logged at WARNING)
  鈹斺攢 Tool dispatcher 鈫?TdaiAdapter 鈫?Gateway
```

### Tools Exposed

| MCP Tool | Wraps | Description |
|:---|:---|:---|
| `tdai_health` | `TdaiAdapter.mcp_health()` | Gateway connectivity + status |
| `tdai_recall` | `TdaiAdapter.recall()` | Cross-session memory recall |
| `tdai_capture` | `TdaiAdapter.capture()` | Store conversation turn |
| `tdai_memory_search` | `TdaiAdapter.search_memory()` | L1 atomic memory search |
| `tdai_conversation_search` | `TdaiAdapter.search_conversation()` | L0 history search |

### Design Decisions

| Decision | Rationale |
|:---|:---|
| **No MCP server framework dependency** | Avoids framework lock-in. The server implements JSON-RPC 2.0 over stdio directly 鈥?trivially auditable, zero supply-chain risk |
| **Five-layer defense gates** | Defense-in-depth for desktop/loopback mode. Gates 2-3 are architectural constraints on stdio (process-per-read resets state); production deployments should front with agentgateway (Linux Foundation AAIF) for session-persistent enforcement |
| **TS client only, no duplicate server** | TypeScript side is a thin `StdioClientTransport` wrapper (~20 lines). Server logic lives in Python once |
| **Gates are always active** | No bypass path even if agentgateway is present. Local gates serve as safety net if agentgateway fails |
| **Graceful fallback chain** | Independent `bridge.mcp_health` module provides health-only fallback (`tdai_health`, 4 gates) if the full server is unavailable. Both share `MCP_BRIDGE_API_KEY` and `BridgeAdapter.mcp_health()` backend |

### Test Coverage

| Suite | Count | Focus |
|:---|:---:|:---|
| Protocol compliance | 14 | JSON-RPC 2.0, tool routing, parameter validation |
| Red-team defense | 13 | Injection, auth bypass, rate limit, circuit breaker attacks |
| Offensive | 22 | Resource exhaustion, info disclosure |
| Ghost attacks | 10 + 2 鈿狅笍 | Architecture-level attacks; rate limit & CB reset per stdio process |

See `bridge/mcp/REDTEAM_FINDINGS.md` for full red-team assessment.

## File Map

| File | Role |
|:---|:---|
| `bridge_adapter/base.py` | TdaiAdapter ABC, BufferedAdapter, structured errors, retry, middleware, registry |
| `bridge_adapter/__init__.py` | BridgeAdapter implementation |
| `bridge_adapter/client.py` | TdaiHttpClient (httpx, 7 endpoints) |
| `bridge_adapter/hermes_v2_adapter.py` | HermesV2Adapter reference implementation |
| `bridge_adapter/plugin.yaml` | TDAI plugin metadata |
| `bridge_adapter/pyproject.toml` | pip install configuration |
| `bridge_adapter/README.md` | Quick start, architecture, config reference |
| `bridge_adapter/integrity.py` | SHA256 integrity tool |
| `bridge_adapter/SHA256SUMS` | Checksum manifest |
| `src/core/types.ts` | MemoryAdapter TypeScript interface |
| `src/core/memory-adapter.test.ts` | 19 TS red-team tests |
| `bridge/mcp/server.py` | MCP stdio server (JSON-RPC 2.0, 5 tools, 4 gates) |
| `bridge/mcp/tdai-memory-client.ts` | MCP TypeScript client (~20 lines, StdioClientTransport) |
| `bridge/mcp/INTEGRATION.md` | MCP integration & verification guide |
| `bridge/mcp/REDTEAM_FINDINGS.md` | Red-team assessment (paper-supplement style) |
| `bridge/mcp/tests/test_protocol.py` | 14 JSON-RPC compliance tests |
| `bridge/mcp/tests/test_redteam.py` | 13 injection/stress/boundary tests |
| `bridge/mcp/tests/test_offensive.py` | 22 resource exhaustion / info disclosure tests |
| `bridge/mcp/tests/test_ghost_attacks.py` | 10 + 2 鈿狅笍 architecture-level attack tests |
| `docs/platform-adapter-comparison.md` | 4-platform comparison + SDK guide |

## Environment Variables

| Variable | Default | Description |
|:---|:---|:---|
| `TDAI_ENDPOINT` | `http://127.0.0.1:8420` | Gateway URL (local or cloud) |
| `TDAI_API_KEY` | `""` | API key (required for cloud) |
| `TDAI_SERVICE_ID` | `mem-rkgqhd5z` | Tenant isolation |
| `TDAI_TIMEOUT` | `30.0` | HTTP request timeout |
| `TDAI_RETRY_ATTEMPTS` | `3` | Max retry attempts |
| `TDAI_BUFFER_DIR` | system temp dir | BufferedAdapter local storage |

## New Platform Adoption

```python
from bridge_adapter import TdaiAdapter, TdaiAdapterRegistry

class MyPlatformAdapter(TdaiAdapter):
    @property
    def name(self): return "my-platform"
    def initialize(self, **kwargs): ...
    def is_available(self): return True
    def _recall_impl(self, query, limit): return {}
    def _capture_impl(self, user, asst, session): return True
    def _search_memory_impl(self, query, limit): return []
    def _search_conversation_impl(self, query, limit): return []
    def shutdown(self): ...

TdaiAdapterRegistry.register("my-platform", MyPlatformAdapter)
```

For buffered capture mode:
```python
from bridge_adapter import BufferedAdapter

class MyBufferedAdapter(BufferedAdapter):
    """Inherits auto-buffering + atexit flush."""
    ...
```
