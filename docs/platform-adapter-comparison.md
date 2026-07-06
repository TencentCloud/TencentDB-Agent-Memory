# Cross-Platform Adapter Comparison

## Platform Matrix

| Dimension | OpenClaw (existing) | Hermes (existing) | MCP Server (new) | Dify Plugin (new) | Python SDK (new) | TS Client (new) |
|:----------|:---:|:---:|:---:|:---:|:---:|:---:|
| **Language** | TypeScript | Python | Python | Python | Python | TypeScript |
| **Integration Pattern** | In-process | Sidecar | MCP stdio | HTTP client | HTTP client | HTTP client |
| **Platforms Served** | OpenClaw only | Hermes only | Claude Code, Trae, Codex, Cursor, CodeBuddy, Windsurf | Dify | Any Python agent | Any TS/Node agent |
| **Dependencies** | openclaw SDK | hermes SDK | stdlib only | stdlib only | stdlib only | Node fetch |
| **Authentication** | Host-managed | Bearer token | Bearer token | Bearer token | Bearer token | Bearer token |
| **Auto-recall** | Hook (before_prompt_build) | Provider.prefetch() | Agent tool call | Workflow node | Client.recall() | Client.recall() |
| **Auto-capture** | Hook (agent_end) | Provider.sync_turn() | Agent tool call | Workflow node | Client.capture() | Client.capture() |
| **LLM Integration** | CleanContextRunner | StandaloneLLMRunner | N/A (client only) | N/A (client only) | N/A (client only) | N/A (client only) |
| **Process Model** | Shared with host | Subprocess | stdio child | HTTP call | HTTP call | HTTP call |
| **Resilience** | Host-managed | Circuit breaker + watchdog | Rate limit + circuit breaker | Retry (SDK) | Retry + backoff | Timeout + abort |
| **Setup Complexity** | Plugin install | pip + config | 1 line MCP config | Dify plugin install | pip/copy | npm/copy |
| **Gateway Required** | No (in-process) | Yes | Yes | Yes | Yes | Yes |

## Lifecycle Mapping

Each platform has its own lifecycle events. Here's how they map to TDAI operations:

| TDAI Operation | OpenClaw | Hermes | MCP Client | Dify |
|:---|:---|:---|:---|:---|
| **Initialize** | Plugin load | `initialize(session_id)` | MCP `initialize` | Plugin install |
| **Recall** | `before_prompt_build` hook | `prefetch(query, session_id)` | `tools/call` → `tdai_recall` | Workflow: tdai_recall node |
| **Capture** | `agent_end` hook | `sync_turn(user, assistant, session_id)` | `tools/call` → `tdai_capture` | Workflow: tdai_capture node |
| **Search** | Tool: `tdai_memory_search` | Tool: `memory_tencentdb_memory_search` | `tools/call` → `tdai_memory_search` | Tool: tdai_memory_search |
| **Session End** | `gateway_stop` hook | `on_session_end(messages)` | (client disconnects) | (session timeout) |
| **Shutdown** | `gateway_stop` hook | `shutdown()` | Process exit | Plugin uninstall |

## When to Use Each Adapter

### Use MCP Server when:
- Your platform supports MCP (Model Context Protocol)
- You want zero-code integration (just add config)
- You need defense gates (rate limiting, circuit breaker) built-in
- Multiple platforms share one deployment

### Use Python SDK when:
- Building a custom Python agent
- Need programmatic control over recall/capture timing
- Want to extend TdaiAdapter with custom behavior
- Integrating into existing Python frameworks (LangChain, AutoGen, etc.)

### Use TypeScript Client when:
- Building a Node.js agent that isn't OpenClaw
- Need type-safe API access
- Want minimal dependency footprint

### Use Dify Plugin when:
- Running Dify as your agent platform
- Want visual workflow integration
- Need no-code memory configuration

### Use OpenClaw adapter when:
- Running on OpenClaw platform (existing, maintained separately)

### Use Hermes adapter when:
- Running on Hermes platform (existing, maintained separately)

## Configuration Comparison

### MCP Server (1 line per platform)

```json
// Claude Code / Cursor / Trae
{ "mcpServers": { "tdai-memory": { "command": "python3", "args": ["path/to/server.py"] } } }
```

### Python SDK (3 lines)

```python
from adapters.python_sdk import TdaiHttpClient
client = TdaiHttpClient(gateway_url="http://127.0.0.1:8420")
result = client.recall("user query", "session-123")
```

### TypeScript Client (3 lines)

```typescript
import { TdaiMemoryClient } from "./tdai-memory-client";
const client = new TdaiMemoryClient({ gatewayUrl: "http://127.0.0.1:8420" });
const result = await client.recall("user query", "session-123");
```

### Dify Plugin (GUI)

Install plugin → Configure gateway URL → Drag tools into workflow.

## Security Model

| Layer | MCP Server | SDK Client | Dify |
|:---|:---|:---|:---|
| Transport | stdio (local) | HTTP (configurable) | HTTP (configurable) |
| Auth | Bearer token (env var) | Bearer token (constructor) | Credential store |
| Rate Limit | Built-in (G2) | Not built-in | Not built-in |
| Circuit Breaker | Built-in (G3) | Not built-in | Not built-in |
| Input Validation | JSON-RPC schema (G0) | Type checking | Schema validation |

## Test Coverage

| Component | Tests | Type |
|:---|:---:|:---|
| MCP Server Protocol | 9 | Integration (subprocess) |
| Python SDK | 10 | Unit (mock HTTP server) |
| **Total** | **19** | |

All tests pass with Python 3.9+ using only stdlib (no pip dependencies).
