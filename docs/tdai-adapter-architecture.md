# TdaiAdapter SDK — Architecture

> **Note**: This is a clean SDK-focused copy of the full architecture document.
> The original (with Bridge-internal details) is at `bridge/docs/TDAI-ARCHITECTURE.md` in the Bridge repository.

## Overview

**TdaiAdapter** is a platform-neutral Python SDK for TencentDB Agent Memory v2 Gateway API.
It provides a unified interface (`TdaiAdapter` ABC) that any agent runtime can implement
to connect to TDAI Gateway for recall, capture, and search operations.

```
┌─────────────────────────────────────────────────────────────┐
│                     Any Platform                             │
│  engine.py / agent hooks → BridgeAdapter / CustomAdapter    │
│                     │                                        │
│                     ▼                                        │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ TdaiAdapter SDK (bridge_adapter.base)                   ││
│  │  recall(query, limit)                                   ││
│  │   ├─ _sanitize_query()      100K truncation + type     ││
│  │   ├─ _sanitize_limit()       [1, 1000] clamping        ││
│  │   ├─ middleware.before()     metrics / auth / logging  ││
│  │   ├─ _with_retry()           3 attempts, exp backoff   ││
│  │   │   └─ _recall_impl()      platform implementation  ││
│  │   ├─ middleware.after()      record latency + counts  ││
│  │   └─ graceful degradation    exception → safe empty   ││
│  │                                                        ││
│  │  BufferedAdapter: optional mixin, local JSONL buffer  ││
│  │  TdaiAdapterRegistry: name-based lookup + health_all() ││
│  └────────────────────┬───────────────────────────────────┘│
└───────────────────────┼─────────────────────────────────────┘
                        │ TdaiHttpClient (httpx, sync)
                        ▼
                 TDAI Gateway (port 8420) → TdaiCore → SQLite
```

## SDK Components

### 1. `TdaiAdapter` (ABC) — `bridge_adapter/base.py`

Abstract base class. Subclasses implement 4 internal methods:

| Public API | Internal method | Description |
|:---|:---|:---|
| `recall(query, limit)` | `_recall_impl(query, limit)` | Cross-session memory → prepend_context |
| `capture(user, assistant, session_id)` | `_capture_impl(...)` | Write conversation turn to L0 |
| `search_memory(query, limit)` | `_search_memory_impl(...)` | Search L1 atomic memories |
| `search_conversation(query, limit)` | `_search_conversation_impl(...)` | Search L0 conversation history |

Each public method shares the same guard stack:
1. **Sanitize** — type check, length truncation (100K chars), limit clamping [1, 1000]
2. **Middleware.before()** — metrics, auth, logging hooks
3. **Retry loop** — exponential backoff (3 attempts, base 0.5s, jitter 10%)
4. **Implementation** — subclass-specific logic
5. **Middleware.after()** — record latency, call count
6. **Graceful degradation** — on exception, return safe empty defaults

### 2. `BridgeAdapter` — `bridge_adapter/__init__.py`

Reference implementation using httpx. Connects to TDAI Gateway REST API.

### 3. `TdaiHttpClient` — `bridge_adapter/client.py`

Thin httpx wrapper for 7 Gateway endpoints:
- `GET /health`
- `POST /v2/conversation/add`
- `POST /v2/conversation/query`
- `POST /v2/atomic/search`
- `POST /v2/scenario/ls`
- `POST /v2/core/read`
- `POST /v2/core/update`

### 4. `BufferedAdapter` — `bridge_adapter/base.py`

Optional mixin that replaces per-call `capture()` with local JSONL buffering.
Flushes to Gateway at buffer_size threshold or on `shutdown()` (with atexit guarantee).

### 5. `TdaiAdapterRegistry` — `bridge_adapter/base.py`

Name-based adapter class registry. Supports `register()`, `get()`, `list()`, `create()`, and `health_all()` (aggregate health check across all registered adapters).

### 6. `HermesV2Adapter` — `bridge_adapter/hermes_v2_adapter.py`

Cross-platform reference implementation using the official Hermes Python SDK.
Demonstrates that `TdaiAdapter` can wrap existing SDKs.

## Key Design Decisions

| Decision | Rationale |
|:---|:---|
| **TdaiAdapter ABC** instead of Hermes MemoryProvider | Hermes MemoryProvider is tightly coupled to Hermes lifecycle (`prefetch`/`sync_turn`). TdaiAdapter is platform-neutral |
| **httpx sync client** | Sync is simpler to integrate across diverse runtimes. Async wrappers can be added at the platform level |
| **Sanitize + retry + middleware** in base class | Every platform gets parameter safety and resilience for free. No opt-in needed |
| **Structured errors** | `TdaiConnectionError` / `TdaiAuthError` / `TdaiTimeoutError` / `TdaiRateLimitError` / `TdaiValidationError` — callers catch specific failures |
| **Exponential backoff** (3 attempts, 0.5s base) | Transient failures auto-retry. Auth and validation errors propagate immediately |
| **Middleware hooks** | `before_call` / `after_call` / `on_error` — for metrics, auth, logging. Built-in `TdaiMetricsMiddleware` |
| **TdaiConfig.from_env()** | Standard config from `TDAI_*` env vars |
| **Local + Cloud dual path** | Default `http://127.0.0.1:8420` (local Gateway). Set `TDAI_ENDPOINT` to cloud URL for cloud mode |
| **Multi-tenant isolation** | `x-tdai-service-id` header on every request. Set `TDAI_SERVICE_ID` per project |
| **BufferedAdapter** | Optional local JSONL buffer. Captures stored locally, flush at buffer_size or session end |
| **Session-level recall cache** | SHA256(query) → cached per adapter lifetime. Prevents prompt prefix cache degradation (#120) |
| **Circuit breaker** (5-fault / 60s) | Prevents cascading failures when Gateway is down |
| **Graceful degradation** | Gateway unreachable → operations return safe empty defaults |
| **SHA256SUMS integrity** | Release verification. `python -m bridge_adapter.integrity --check` |

## Cross-Language SDK

| Language | Interface | Install | File | Tests |
|:---|:---|:---|:---|:---:|
| **Python** | `TdaiAdapter` (ABC) | `pip install bridge_adapter` | `bridge_adapter/base.py` | 37 red-team + 20 provider |
| **TypeScript** | `MemoryAdapter` (interface) | `npm install @tencentdb-agent-memory/memory-tencentdb` | `src/core/types.ts` | 19 red-team |

Both define the same contract: `recall` / `capture` / `searchMemory` / `searchConversation`
with parameter validation and graceful degradation.

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
