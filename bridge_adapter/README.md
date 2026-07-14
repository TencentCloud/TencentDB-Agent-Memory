# Bridge Adapter -TDAI Memory SDK

Bridge platform adapter for [TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) v2 Gateway API.

## Quick Start

```bash
pip install bridge_adapter
```

```python
from bridge_adapter import BridgeAdapter

adapter = BridgeAdapter()
adapter.initialize()

# Recall: inject cross-session memories
ctx = adapter.recall("user preference")
print(ctx["prepend_context"])

# Capture: store a conversation turn
adapter.capture("user message", "assistant response", session_id="sess-1")

# Search: explicit memory lookup
memories = adapter.search_memory("relevant topic")

# Profile: sync user preferences to L3
adapter.sync_profile({"preferred_languages": ["Python"]})
```

## Architecture

```
 - - Your Platform - - engine.py / agent hooks -TdaiAdapter SDK - - - - - - - - - - - -TdaiAdapter (ABC) -base.py - - - - recall(query, limit) sanitize -retry -impl - - - - capture(user, asst) sanitize -retry -impl - - - - search_memory(query) sanitize -retry -impl - - - - search_conversation() sanitize -retry -impl - - - - middleware hooks metrics / auth / logging - - - - - - -TdaiHttpClient (httpx) - - - TDAI Gateway (port 8420) -TdaiCore -SQLite
```

## Environment Variables

| Variable | Default | Description |
|:---|:---|:---|
| `TDAI_ENDPOINT` | `http://127.0.0.1:8420` | Gateway URL (local or cloud) |
| `TDAI_API_KEY` | `""` | API key (required for cloud, optional for local) |
| `TDAI_SERVICE_ID` | `mem-rkgqhd5z` | Tenant isolation -different value per project |
| `TDAI_TIMEOUT` | `30.0` | HTTP request timeout (seconds) |
| `TDAI_RETRY_ATTEMPTS` | `3` | Max retry attempts for transient failures |
| `TDAI_BUFFER_DIR` | system temp dir | BufferedAdapter local JSONL storage path |

## Deployment Modes

### Local Gateway (default)
```bash
# Start TDAI Gateway locally
npx tsx src/gateway/server.ts

# Use default env (no config needed)
python my_app.py
```

### Cloud API
```bash
export TDAI_ENDPOINT=https://api.tdai.example.com
export TDAI_API_KEY=sk-xxxxx
export TDAI_SERVICE_ID=my-project
python my_app.py
```

### Multi-tenant (multiple repos/projects)
```bash
# Repo A
export TDAI_SERVICE_ID="repo-spz-gatekeeper"
# Repo B
export TDAI_SERVICE_ID="repo-bridge-core"
```

## SDK Contents

| File | Content | Lines |
|:---|:---|:---:|
| `base.py` | `TdaiAdapter` ABC, `BufferedAdapter` mixin, structured errors, retry, middleware, `TdaiConfig`, `TdaiAdapterRegistry` | ~380 |
| `__init__.py` | `BridgeAdapter` (Bridge platform implementation) | ~300 |
| `client.py` | `TdaiHttpClient` (httpx wrapper, 7 Gateway endpoints) | ~120 |
| `hermes_v2_adapter.py` | `HermesV2Adapter` -cross-platform reference implementation | ~130 |
| `plugin.yaml` | TDAI plugin metadata | ~12 |
| `pyproject.toml` | Package build config (pip install -e ready) | ~13 |

## Cross-References

| Document | Location | Content |
|:---|:---|:---|
| SDK architecture | `docs/tdai-adapter-architecture.md` (TDAI repo) | Full architecture, component breakdown, design decisions, cross-language SDK |
| Platform comparison | `docs/platform-adapter-comparison.md` (TDAI repo) | 4-platform matrix, data flows, design decisions |

## Cross-Language SDK

The adapter interface is available in two languages, each installed separately:

| Language | Interface | Install | File | Tests |
|:---|:---|:---|:---|:---:|
| **Python** | `TdaiAdapter` (ABC) | `pip install bridge_adapter` | `bridge_adapter/base.py` | 37 red-team + 20 provider |
| **TypeScript** | `MemoryAdapter` (interface) + `BaseMemoryAdapter` (base class) + `TdaiHttpClient` | `npm install @tencentdb-agent-memory/memory-tencentdb` | `src/core/types.ts` + `src/core/base-memory-adapter.ts` + `src/core/tdai-http-client.ts` | 29 red-team + unit |

Both define the same contract: `recall`/`capture`/`searchMemory`/`searchConversation` with parameter validation and graceful degradation.

## Platform Adapters

| Adapter | Platform | Backend | Lines |
|:---|:---|:---|---:|
| **BridgeAdapter** | Bridge (ZTHL) | httpx -TDAI Gateway | ~130 |
| **CodexAdapter** | OpenAI Codex | MCP stdio -`codex mcp call` | ~174 |
| **HermesV2Adapter** | Hermes Agent | Hermes Python SDK | ~100 |

### CodexAdapter

[Codex](https://github.com/openai/codex) has a built-in `memories` extension. `CodexAdapter` wraps it
via MCP stdio, mapping `recall`/`search_memory` -`memories__search`, `capture` -`memories__add_ad_hoc_note`, `search_conversation` -`memories__list`.

Requires Codex CLI v0.137.0+ on PATH.

```python
from bridge_adapter import TdaiAdapterRegistry

adapter = TdaiAdapterRegistry.create("codex", codex_path="codex")
ctx = adapter.recall("coding conventions")
adapter.capture("user message", "assistant response")
```

## New Platform Adoption

```python
from bridge_adapter import TdaiAdapter, TdaiAdapterRegistry

class MyPlatformAdapter(TdaiAdapter):
 """6 methods to implement."""
 @property
 def name(self): return "my-platform"
 def initialize(self, **kwargs): ...
 def is_available(self): return True
 def _recall_impl(self, query, limit): return {}
 def _capture_impl(self, user, assistant, session): return True
 def _search_memory_impl(self, query, limit): return []
 def _search_conversation_impl(self, query, limit): return []
 def shutdown(self): ...

TdaiAdapterRegistry.register("my-platform", MyPlatformAdapter)
# TdaiAdapterRegistry.health_all() -aggregate health check
```

For buffered mode (capture locally, flush in batch):

```python
from bridge_adapter import BufferedAdapter

class MyBufferedAdapter(BufferedAdapter):
 """Inherits auto-buffering + atexit flush."""
 ...
```
