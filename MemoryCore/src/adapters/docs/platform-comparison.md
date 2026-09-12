# Platform Comparison

> Side-by-side comparison of all platform adapters built on the Unified Adapter SDK.

## 1. Platform Overview

| Feature | Claude Code | Codex CLI | Dify | OpenClaw | Standalone |
|---------|------------|-----------|------|----------|------------|
| **Language** | TypeScript | TypeScript | Python | TypeScript | TypeScript |
| **Integration model** | MCP Server (stdio JSON-RPC) | Lifecycle hooks | Plugin provider | In-process plugin | HTTP API |
| **Transport** | stdio (JSON-RPC 2.0) | Direct function calls | Dify plugin runtime | In-process | HTTP REST |
| **Tool registration** | MCP `tools/list` + `tools/call` | OpenAI function-calling | Dify YAML + Python | Plugin manifest | Gateway tools API |
| **Prompt format** | XML tags | Markdown | XML tags | Markdown | JSON |
| **Recall injection** | `prependContext` + `appendSystemContext` | `prependContext` + `appendSystemContext` | `prependContext` + `appendSystemContext` | `prependContext` + `appendSystemContext` | API response |
| **Capture trigger** | Automatic (hook) | `afterResponse` hook | Workflow node | `afterToolCall` hook | API call |
| **Session management** | `TDAI_SESSION_ID` env | `sessionId` param | Dify conversation ID | OpenClaw session | API param |
| **External deps** | None (native `readline`) | None | `requests` (or stdlib) | OpenClaw SDK | None |

## 2. Recall Result Formatting

Each platform formats the same recall data differently, matching its LLM's prompt conventions:

### Claude Code (XML tags)

```xml
<relevant-memories>

- [persona] (score: 0.952) Prefers dark mode and concise answers
- [episodic] (score: 0.871) Discussed React state management on 2024-03-15

</relevant-memories>
```

System prompt append:
```xml
<user-persona>
Alice is a senior frontend developer who values clean, minimal code...
</user-persona>

<scene-navigation>
The following scene memory index is available. Use tdai_read_scene to read any scene's full content.

- `scene_blocks/travel-plan.md` — Summer vacation planning
- `scene_blocks/project-setup.md` — React project initialization
</scene-navigation>

<memory-tools-guide>
## Memory Tools Guide
...
</memory-tools-guide>
```

### Codex CLI (Markdown)

```markdown
## Relevant Memories

The following memories were recalled for this conversation. They are contextual references only and may not reflect the current task.

- **[episodic]** User prefers TypeScript over JavaScript (score: 0.92)
- **[instruction]** Always use functional components in React (score: 0.87)
```

System prompt append:
```markdown
## User Persona

Alice is a senior frontend engineer who values clean, type-safe code.

## Scene Navigation

The following scene blocks are available. Use the `tdai_read_scene` tool to read a scene's full content.

- `travel-plan.md` — Summer trip to Japan _(heat: 3)_
- `project-setup.md` — React project initialization

## Memory Tools

- `tdai_memory_search` — Search structured memories (L1).
- `tdai_conversation_search` — Search raw conversations (L0).
- `tdai_read_scene` — Read a scene block by name.

_Limit: max 3 combined search calls per turn._
```

### Dify (XML tags)

```xml
<relevant-memories>
The following relevant memories were recalled for reference only:

- [persona] Prefers dark mode and concise answers
- [episodic] Discussed React state management on 2024-03-15
</relevant-memories>
```

System prompt append:
```xml
<user-core>
Alice is a senior frontend developer who values clean, minimal code...
</user-core>

<scene-navigation>
The following scene memory index is available:

- travel-plan.md — Summer vacation planning
- project-setup.md — React project initialization
</scene-navigation>
```

## 3. Message Normalization

Each platform represents conversations differently. The adapter's `normalizeMessages()`
converts them all to the standard `ConversationMessage[]` format:

| Platform | Input format | Role mapping | Content extraction |
|----------|-------------|--------------|-------------------|
| **Claude Code** | `[{role, content}]` where content may be string or array of blocks (`text`, `tool_use`, `tool_result`) | `user`/`assistant`/`system` directly; `tool` from `tool_result` blocks | String directly; block arrays: extract `text` from `text` blocks, `input` from `tool_use` blocks |
| **Codex CLI** | `[{role, content, timestamp}]` where content may be string, array of blocks, or null | `user`/`human`→`user`, `assistant`/`ai`/`bot`→`assistant`, `system`/`developer`→`system`, `tool`/`function`→`tool` | String directly; block arrays: extract `text`/`input_text`; null→skip |
| **Dify** | `[{query, answer}]` pairs OR `[{role, content}]` OR plain string | `query`→`user`, `answer`→`assistant`; or direct role mapping | `query`/`answer` fields; or `content` field |
| **OpenClaw** | `[{role, content}]` | Direct mapping | String directly |
| **Standalone** | OpenAI chat format `[{role, content}]` | Direct mapping | String directly |

## 4. Tool Definitions

All platforms expose the same three memory tools, but with different schemas:

### Tool Name Conventions

| Standard tool | Claude Code | Codex CLI | Dify |
|---------------|-------------|-----------|------|
| Memory search | `tdai_memory_search` | `tdai_memory_search` | `memory_search` |
| Conversation search | `tdai_conversation_search` | `tdai_conversation_search` | `conversation_search` |
| Read scene | `tdai_read_scene` | `tdai_read_scene` | `read_scene` |

> Dify uses shorter names (without the `tdai_` prefix) because Dify tool names
> are scoped to the plugin namespace.

### Tool Schema Formats

**Claude Code** (MCP input schema):
```json
{
  "name": "tdai_memory_search",
  "description": "Search structured long-term memories (L1)...",
  "inputSchema": {
    "type": "object",
    "properties": { "query": { "type": "string" } },
    "required": ["query"]
  }
}
```

**Codex CLI** (OpenAI function-calling):
```json
{
  "type": "function",
  "function": {
    "name": "tdai_memory_search",
    "description": "Search structured long-term memories (L1)...",
    "parameters": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"]
    }
  }
}
```

**Dify** (YAML manifest):
```yaml
identity:
  name: memory_search
  label: {en_US: "Memory Search", zh_Hans: "记忆搜索"}
parameters:
  - name: query
    type: string
    required: true
    form: llm
```

## 5. Configuration Comparison

| Config source | Claude Code | Codex CLI | Dify |
|---------------|-------------|-----------|------|
| **Environment variables** | Yes (primary) | Yes (primary) | Yes (fallback) |
| **Programmatic override** | Yes (constructor) | Yes (factory config) | Yes (credentials) |
| **Platform config file** | `claude_desktop_config.json` | Codex config | Dify plugin credentials |
| **Credential injection** | Via MCP `env` | Via env vars | Via `self.runtime.credentials` |

### Dify-specific credential keys

Dify injects credentials through its plugin runtime, which override environment
variables:

| Credential key | Env var equivalent |
|----------------|-------------------|
| `gateway_endpoint` | `TDAI_GATEWAY_ENDPOINT` |
| `gateway_api_key` | `TDAI_GATEWAY_API_KEY` |
| `gateway_service_id` | `TDAI_GATEWAY_SERVICE_ID` |
| `gateway_timeout_ms` | `TDAI_GATEWAY_TIMEOUT_MS` |
| `team_id` | `TDAI_TEAM_ID` |
| `agent_id` | `TDAI_AGENT_ID` |
| `user_id` | `TDAI_USER_ID` |

## 6. Error Handling & Resilience

All adapters inherit the same resilience patterns from `MemoryAdapterBase`:

| Pattern | Behavior | Inherited? |
|---------|----------|------------|
| **Circuit breaker** | Opens after 5 consecutive failures; cools down for 60s | Yes (all) |
| **Graceful degradation** | All methods return empty results on failure — never throw | Yes (all) |
| **Non-blocking health check** | `initialize()` succeeds even if Gateway is down | Yes (all) |
| **Per-call try/catch** | Each recall/capture/search is wrapped | Yes (all) |
| **Platform-level hook guards** | Hook handlers never throw into the host | Claude Code: SIGINT/SIGTERM; Codex: per-hook try/catch; Dify: tool-level try/except |

### Platform-specific error handling

| Platform | Additional resilience |
|----------|----------------------|
| **Claude Code** | SIGINT/SIGTERM handlers for clean shutdown; stderr-only logging to avoid corrupting JSON-RPC on stdout |
| **Codex CLI** | `CodexHooks` wraps each hook handler in try/catch; `onToolCall` returns JSON error envelope |
| **Dify** | Tool-level try/except; errors returned as Dify `text_message` with error description |

## 7. Performance Characteristics

| Aspect | Claude Code | Codex CLI | Dify |
|--------|-------------|-----------|------|
| **Startup latency** | Process spawn + MCP handshake (~100ms) | Direct import (~10ms) | Plugin load (~200ms) |
| **Recall latency** | 1 HTTP round-trip (parallel L1+L3+L2) | Same | Same |
| **Capture latency** | 1 HTTP POST | Same | Same |
| **Tool call latency** | 1 HTTP round-trip per call | Same | Same |
| **Memory overhead** | Separate process (~30MB) | In-process (~5MB) | Plugin process (~50MB) |
| **Concurrency** | Single-threaded (stdio) | Single-threaded (hooks) | Async (Dify runtime) |

## 8. Use Case Recommendations

| Use case | Recommended platform | Reason |
|----------|---------------------|--------|
| **Desktop AI coding assistant** | Claude Code | MCP is the standard protocol; stdio transport is simple and reliable |
| **CLI-based coding agent** | Codex CLI | Lifecycle hooks integrate naturally with CLI workflows |
| **No-code AI platform** | Dify | Plugin system + visual workflow builder; credential management |
| **Embedded agent framework** | OpenClaw | In-process plugin; lowest latency; direct function calls |
| **Gateway-side memory API** | Standalone | HTTP REST API; language-agnostic; use from any client |
| **Custom Python agent** | Python SDK | Direct `MemoryAdapterBase` extension; no framework lock-in |
| **Custom TypeScript agent** | TypeScript SDK | Direct `MemoryAdapterBase` extension; type-safe |

## 9. Feature Matrix

| Capability | Claude Code | Codex CLI | Dify | OpenClaw | Standalone |
|-----------|-------------|-----------|------|----------|------------|
| L0 conversation capture | Yes | Yes | Yes | Yes | Yes |
| L1 memory search | Yes | Yes | Yes | Yes | Yes |
| L1 memory recall (auto-inject) | Yes | Yes | Yes | Yes | No (manual) |
| L2 scene navigation | Yes | Yes | Yes | Yes | Yes |
| L2 scene read (tool) | Yes | Yes | Yes | Yes | Yes |
| L3 persona injection | Yes | Yes | Yes | Yes | No (manual) |
| Circuit breaker | Yes | Yes | Yes | No (legacy) | No (legacy) |
| Graceful degradation | Yes | Yes | Yes | Partial | Partial |
| Environment variable config | Yes | Yes | Yes | No (legacy) | No (legacy) |
| Programmatic config override | Yes | Yes | Yes | No (legacy) | No (legacy) |
| Multi-tenant isolation | Yes | Yes | Yes | No (legacy) | No (legacy) |
| Bilingual (TS + Python) | TS only | TS only | Python only | TS only | TS only |
