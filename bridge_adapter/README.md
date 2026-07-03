# Bridge Adapter 鈥?TDAI Memory SDK

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
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?鈹?                    Your Platform                        鈹?鈹? engine.py / agent hooks 鈫?TdaiAdapter SDK               鈹?鈹?                    鈹?                                    鈹?鈹?                    鈻?                                    鈹?鈹? 鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹? 鈹?鈹? 鈹?TdaiAdapter (ABC) 鈥?base.py                        鈹? 鈹?鈹? 鈹? 鈹溾攢 recall(query, limit)  sanitize 鈫?retry 鈫?impl 鈹? 鈹?鈹? 鈹? 鈹溾攢 capture(user, asst)   sanitize 鈫?retry 鈫?impl 鈹? 鈹?鈹? 鈹? 鈹溾攢 search_memory(query)  sanitize 鈫?retry 鈫?impl 鈹? 鈹?鈹? 鈹? 鈹溾攢 search_conversation() sanitize 鈫?retry 鈫?impl 鈹? 鈹?鈹? 鈹? 鈹斺攢 middleware hooks      metrics / auth / logging 鈹? 鈹?鈹? 鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹? 鈹?鈹?                      鈹?TdaiHttpClient (httpx)            鈹?鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹尖攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                        鈻?              TDAI Gateway (port 8420) 鈫?TdaiCore 鈫?SQLite
```

## Environment Variables

| Variable | Default | Description |
|:---|:---|:---|
| `TDAI_ENDPOINT` | `http://127.0.0.1:8420` | Gateway URL (local or cloud) |
| `TDAI_API_KEY` | `""` | API key (required for cloud, optional for local) |
| `TDAI_SERVICE_ID` | `mem-rkgqhd5z` | Tenant isolation 鈥?different value per project |
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
| `hermes_v2_adapter.py` | `HermesV2Adapter` 鈥?cross-platform reference implementation | ~130 |
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
| **TypeScript** | `MemoryAdapter` (interface) | `npm install @tencentdb-agent-memory/memory-tencentdb` | `src/core/types.ts` | 19 red-team (`src/core/memory-adapter.test.ts`) |

Both define the same contract: `recall`/`capture`/`searchMemory`/`searchConversation` with parameter validation and graceful degradation.

## Platform Adapters

| Adapter | Platform | Backend | Lines |
|:---|:---|:---|---:|
| **BridgeAdapter** | Bridge (ZTHL) | httpx 鈫?TDAI Gateway | ~130 |
| **CodexAdapter** | OpenAI Codex | MCP stdio 鈫?`codex mcp call` | ~174 |
| **HermesV2Adapter** | Hermes Agent | Hermes Python SDK | ~100 |

### CodexAdapter

[Codex](https://github.com/openai/codex) has a built-in `memories` extension. `CodexAdapter` wraps it
via MCP stdio, mapping `recall`/`search_memory` 鈫?`memories__search`, `capture` 鈫?`memories__add_ad_hoc_note`, `search_conversation` 鈫?`memories__list`.

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
# TdaiAdapterRegistry.health_all()  鈥?aggregate health check
```

For buffered mode (capture locally, flush in batch):

```python
from bridge_adapter import BufferedAdapter

class MyBufferedAdapter(BufferedAdapter):
    """Inherits auto-buffering + atexit flush."""
    ...
```
