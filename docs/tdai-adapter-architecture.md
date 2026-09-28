# TDAI Cross-Platform Adapter Architecture

## Overview

TencentDB Agent Memory (TDAI) provides a multi-layer memory system for AI agents. This document describes the adapter architecture that enables any agent platform to integrate TDAI memory capabilities.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Agent Platforms                                   │
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────────────┤
│  Claude  │  Codex   │   Trae   │  Cursor  │   Dify   │  Custom Agent   │
│   Code   │   CLI    │   IDE    │          │          │                  │
└────┬─────┴────┬─────┴────┬─────┴────┬─────┴────┬─────┴────────┬────────┘
     │          │          │          │          │               │
     ▼          ▼          ▼          ▼          ▼               ▼
┌─────────────────────────────────────┐  ┌───────────────┐  ┌──────────┐
│        MCP stdio Server             │  │  Dify Plugin  │  │  Python  │
│  (JSON-RPC 2.0 over stdin/stdout)   │  │  (provider)   │  │   SDK    │
│                                     │  └───────┬───────┘  └────┬─────┘
│  Defense Gates: G0-G3               │          │               │
│  • G0: JSON-RPC schema validation   │          │               │
│  • G1: API key authentication       │          │               │
│  • G2: Rate limiting                │          │               │
│  • G3: Circuit breaker              │          │               │
└──────────────────┬──────────────────┘          │               │
                   │                             │               │
                   ▼                             ▼               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        TDAI Gateway (HTTP)                                │
│                                                                          │
│  Endpoints:                                                              │
│  • GET  /health              → Health check                              │
│  • POST /recall              → Memory retrieval (before LLM turn)        │
│  • POST /capture             → Conversation recording (after turn)       │
│  • POST /search/memories     → L1 structured memory search               │
│  • POST /search/conversations → L0 raw conversation search              │
│  • POST /session/end         → Session flush                             │
│  • POST /seed                → Batch historical import                   │
│                                                                          │
│  Default: http://127.0.0.1:8420                                          │
└──────────────────────────────────────┬──────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           TdaiCore Engine                                 │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐    │
│  │    L0    │  │    L1    │  │    L2    │  │         L3           │    │
│  │  Record  │  │ Extract  │  │  Scene   │  │  Persona/Profile     │    │
│  │ (raw)    │  │(memories)│  │ (blocks) │  │  (long-term model)   │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────────┘    │
│                                                                          │
│  Storage: SQLite + Vector Store (sqlite-vec / TencentDB VectorDB)        │
│  Embedding: Configurable (OpenAI-compatible)                             │
│  LLM: Configurable (extraction, summarization)                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### Recall Flow (Before LLM Turn)

```
Platform → [recall(query, session_key)]
         → Gateway POST /recall
         → TdaiCore.handleBeforeRecall()
         → Vector search (L1 memories)
         → Keyword search (BM25)
         → L3 persona context
         → RecallResult { context, strategy, memory_count }
         → Platform injects context into prompt
```

### Capture Flow (After LLM Turn)

```
Platform → [capture(user_content, assistant_content, session_key)]
         → Gateway POST /capture
         → TdaiCore.handleTurnCommitted()
         → L0 recording (raw conversation)
         → L0 vector indexing
         → Pipeline scheduler notification
         → (async) L1 extraction → L2 scene building → L3 persona update
         → CaptureResult { l0_recorded, scheduler_notified }
```

### Search Flow (Agent Tool Call)

```
Agent → [search_memories(query, limit?, type?, scene?)]
      → Gateway POST /search/memories
      → TdaiCore.searchMemories()
      → Hybrid vector + keyword search over L1 records
      → SearchResult { results, total, strategy }
```

## Adapter Interface Contract

```python
class TdaiAdapter(ABC):
    @abstractmethod
    def recall(self, query: str, session_key: str, **kwargs) -> RecallResult: ...

    @abstractmethod
    def capture(self, user_content: str, assistant_content: str,
                session_key: str, **kwargs) -> CaptureResult: ...

    @abstractmethod
    def search_memories(self, query: str, **kwargs) -> SearchResult: ...

    @abstractmethod
    def search_conversations(self, query: str, **kwargs) -> SearchResult: ...

    def health(self) -> HealthStatus: ...
    def end_session(self, session_key: str) -> bool: ...
    def destroy(self) -> None: ...
```

## Integration Patterns

### Pattern A: MCP stdio (Recommended for MCP-native clients)

Single server process, any MCP client connects with one config line.
No per-platform adapter code needed.

**Advantages:** Zero code for new platforms, defense gates always active, single update point.

**Platforms:** Claude Code, Trae IDE/CLI, Codex CLI, Cursor, CodeBuddy, Windsurf.

### Pattern B: Direct HTTP Client (For custom integrations)

Platform-specific code uses TdaiHttpClient (Python/TypeScript) to call Gateway.
Best when deep lifecycle integration is needed.

**Advantages:** Full control, type safety, custom retry/middleware.

**Platforms:** Dify, LangChain, custom agents.

### Pattern C: In-Process (For tight coupling)

Platform directly instantiates TdaiCore with a HostAdapter implementation.
Only for TypeScript/Node.js platforms with process affinity.

**Advantages:** No HTTP overhead, shared memory, direct pipeline access.

**Platforms:** OpenClaw (existing).

### Pattern D: Sidecar Gateway (For cross-language platforms)

Platform spawns Gateway as subprocess, communicates via localhost HTTP.
The Hermes pattern - Python agent controls Node.js gateway lifecycle.

**Advantages:** Language-agnostic, process isolation, independent scaling.

**Platforms:** Hermes (existing).

## File Structure

```
adapters/
├── mcp-server/
│   ├── server.py          # MCP stdio server (Pattern A)
│   └── README.md          # Integration guide
├── python-sdk/
│   ├── __init__.py        # Package exports
│   ├── base.py            # TdaiAdapter ABC + data classes
│   ├── client.py          # TdaiHttpClient (Pattern B)
│   ├── registry.py        # Multi-adapter registry
│   ├── errors.py          # Typed exceptions
│   └── tests/
│       ├── test_sdk.py    # SDK unit tests (10)
│       └── test_mcp_server.py  # MCP protocol tests (9)
├── dify-plugin/
│   ├── manifest.json      # Dify plugin manifest
│   ├── provider.yaml      # Tool provider config
│   └── provider.py        # Dify tool implementation
├── codex-cli/
│   └── tdai-memory-client.ts  # TypeScript HTTP client
└── README.md              # This document
```
