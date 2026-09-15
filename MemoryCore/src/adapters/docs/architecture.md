# Cross-Platform Adapter Architecture

> Issue #235 — Unified SDK for multi-platform memory integration.

## 1. Design Goals

| Goal | How achieved |
|------|-------------|
| **Platform-agnostic** | The SDK has zero dependencies on OpenClaw, Hermes, MCP, or any specific agent framework. |
| **Minimal surface area** | Each platform implements only 4 abstract methods; all Gateway I/O, circuit breaking, and error handling are inherited. |
| **Graceful degradation** | Every public method returns empty results on failure rather than throwing — the host agent never crashes. |
| **Consistent memory operations** | All platforms produce the same L0/L1/L2/L3 memory effects regardless of their prompt format. |
| **Bilingual SDK** | TypeScript SDK for Claude Code / Codex / OpenClaw; Python SDK for Dify / Hermes. Both share identical interface contracts. |

## 2. High-Level Architecture

```mermaid
graph TB
    subgraph "Host Platforms"
        CC[Claude Code]
        CX[Codex CLI]
        DF[Dify]
        OC[OpenClaw]
        HM[Hermes]
    end

    subgraph "Platform Adapters (implement 4 methods each)"
        CCA[ClaudeCodeAdapter]
        CXA[CodexAdapter]
        DFA[MemoryTencentdbDifyProvider]
        OCA[OpenClawHostAdapter]
        HMA[HermesAdapter]
    end

    subgraph "Unified Adapter SDK"
        BASE_TS["MemoryAdapterBase (TS)<br/>recall / capture / search<br/>circuit breaker / health check"]
        BASE_PY["MemoryAdapterBase (Py)<br/>same interface, Python port"]
        GW_TS["MemoryGatewayClient (TS)<br/>HTTP v3 API"]
        GW_PY["MemoryGatewayClient (Py)<br/>HTTP v3 API"]
    end

    subgraph "TDAI Gateway"
        GW_SVR["Gateway Server<br/>:8420"]
        L0["L0 Conversation<br/>(raw messages)"]
        L1["L1 Structured<br/>Memories"]
        L2["L2 Scene<br/>Navigation"]
        L3["L3 Persona<br/>Core"]
    end

    CC --> CCA
    CX --> CXA
    DF --> DFA
    OC --> OCA
    HM --> HMA

    CCA --> BASE_TS
    CXA --> BASE_TS
    OCA --> BASE_TS

    DFA --> BASE_PY
    HMA --> BASE_PY

    BASE_TS --> GW_TS
    BASE_PY --> GW_PY

    GW_TS --> GW_SVR
    GW_PY --> GW_SVR

    GW_SVR --> L0
    GW_SVR --> L1
    GW_SVR --> L2
    GW_SVR --> L3
```

## 3. Four-Layer Memory Model

All adapters interact with the same four-layer memory model through the Gateway:

```mermaid
graph LR
    subgraph "Memory Layers"
        L0["L0 — Conversation<br/>Raw messages, timestamped<br/>Write: capture()<br/>Read: searchConversations()"]
        L1["L1 — Structured<br/>Episodic / persona / instruction<br/>Write: auto-extraction<br/>Read: searchMemories() / recall()"]
        L2["L2 — Scenes<br/>Topic-blocked summaries<br/>Write: scene extractor<br/>Read: readScene() / recall()"]
        L3["L3 — Persona<br/>User core profile<br/>Write: persona generator<br/>Read: recall()"]
    end

    L0 -->|"auto-extract"| L1
    L0 -->|"scene detect"| L2
    L0 -->|"persona update"| L3
    L1 -->|"dedup / merge"| L1
```

## 4. SDK Class Hierarchy

```mermaid
classDiagram
    class IPlatformAdapter {
        <<interface>>
        +platformName: string
        +formatRecallResult(result: RecallResult) FormattedRecallResult
        +getToolDefinitions() ToolDefinition[]
        +formatToolResult(toolName, rawResult) string
        +normalizeMessages(rawMessages, context?) ConversationMessage[]
    }

    class MemoryAdapterBase {
        <<abstract>>
        #client: MemoryGatewayClient
        #config: AdapterConfig
        #consecutiveFailures: int
        #breakerOpenUntil: float
        +initialize(config) void
        +recall(query, sessionId?) Tuple
        +capture(rawMessages, sessionId?) CaptureResult
        +searchMemories(query, options?) SearchResult
        +searchConversations(query, options?) SearchResult
        +readScene(sceneId) string
        +handleToolCall(toolName, args) string
        +setSessionId(id) void
        +shutdown() void
        #isBreakerOpen() boolean
        #recordSuccess() void
        #recordFailure() void
    }

    class ClaudeCodeAdapter {
        +platformName = "claude-code"
        +formatRecallResult() FormattedRecallResult
        +getToolDefinitions() ToolDefinition[]
        +formatToolResult() string
        +normalizeMessages() ConversationMessage[]
    }

    class CodexAdapter {
        +platformName = "codex"
        +formatRecallResult() FormattedRecallResult
        +getToolDefinitions() ToolDefinition[]
        +formatToolResult() string
        +normalizeMessages() ConversationMessage[]
    }

    class MemoryTencentdbDifyProvider {
        +platformName = "dify"
        +format_recall_result() FormattedRecallResult
        +get_tool_definitions() list
        +format_tool_result() str
        +normalize_messages() list
    }

    IPlatformAdapter <|.. MemoryAdapterBase
    MemoryAdapterBase <|-- ClaudeCodeAdapter
    MemoryAdapterBase <|-- CodexAdapter
    MemoryAdapterBase <|-- MemoryTencentdbDifyProvider
```

## 5. Recall Data Flow

The recall operation fetches L1 + L3 + L2 in parallel, then formats them per-platform:

```mermaid
sequenceDiagram
    participant Host as Host Platform<br/>(e.g. Claude Code)
    participant Adapter as PlatformAdapter
    participant Base as MemoryAdapterBase
    participant Client as GatewayClient
    participant GW as TDAI Gateway

    Host->>Adapter: recall("user query", sessionId)
    Adapter->>Base: super.recall(query, sessionId)

    par Parallel fetch
        Base->>Client: searchMemories(query, L1)
        Client->>GW: POST /v3/memories/search
        GW-->>Client: L1 memory items
    and
        Base->>Client: getPersona(L3)
        Client->>GW: GET /v3/persona
        GW-->>Client: L3 persona content
    and
        Base->>Client: getScenes(L2)
        Client->>GW: GET /v3/scenes
        GW-->>Client: L2 scene entries
    end

    Client-->>Base: {memories, persona, scenes}
    Base->>Adapter: formatRecallResult(RecallResult)
    Adapter-->>Base: {prependContext, appendSystemContext}
    Base-->>Host: (prepend, append)

    Note over Host: prepend → inject before user message<br/>append → inject into system prompt
```

## 6. Capture Data Flow

The capture operation normalizes platform messages and records them as L0:

```mermaid
sequenceDiagram
    participant Host as Host Platform<br/>(e.g. Codex)
    participant Adapter as PlatformAdapter
    participant Base as MemoryAdapterBase
    participant Client as GatewayClient
    participant GW as TDAI Gateway

    Host->>Adapter: capture(rawMessages, sessionId)
    Adapter->>Base: super.capture(rawMessages, sessionId)

    Base->>Adapter: normalizeMessages(rawMessages)
    Note over Adapter: Platform-specific format<br/>(e.g. {role,content} for Codex,<br/>{query,answer} for Dify)
    Adapter-->>Base: ConversationMessage[]

    Base->>Client: capture(messages, session, tenancy)
    Client->>GW: POST /v3/conversations/add
    GW-->>Client: {capturedCount, success}
    Client-->>Base: CaptureResult
    Base-->>Host: CaptureResult
```

## 7. Circuit Breaker Pattern

All adapters inherit a circuit breaker for resilience:

```mermaid
stateDiagram-v2
    [*] --> Closed

    state Closed {
        [*] --> OperationOK
        OperationOK --> OperationOK: success
        OperationOK --> OperationFail: Gateway error
        OperationFail --> OperationOK: success (reset counter)
    }

    Closed --> Open: 5 consecutive failures
    state Open {
        [*] --> Rejecting
        Rejecting: Return empty results<br/>Skip Gateway calls
    }

    Open --> HalfOpen: 60s cooldown elapsed

    state HalfOpen {
        [*] --> Probing
        Probing --> Closed: First call succeeds
        Probing --> Open: First call fails
    }
```

### Breaker Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `BREAKER_THRESHOLD` | 5 | Consecutive failures before opening |
| `BREAKER_COOLDOWN_MS` | 60,000 | Cool-down before half-open probe |

## 8. File Layout

```
MemoryCore/src/adapters/
├── sdk/                          # Unified Adapter SDK (TypeScript)
│   ├── types.ts                  # Core interfaces & data types
│   ├── gateway-client.ts         # HTTP client for v3 API
│   ├── base-adapter.ts           # MemoryAdapterBase (abstract)
│   └── index.ts                  # Barrel exports
├── claude-code/                  # Claude Code MCP adapter
│   ├── adapter.ts                # ClaudeCodeAdapter + main()
│   ├── mcp-server.ts             # JSON-RPC 2.0 over stdio
│   ├── index.ts                  # Barrel exports
│   └── README.md
├── codex/                        # Codex CLI adapter
│   ├── codex-adapter.ts          # CodexAdapter + factory
│   ├── hooks.ts                  # CodexHooks (lifecycle integration)
│   ├── index.ts                  # Barrel exports
│   └── README.md
├── openclaw/                     # OpenClaw adapter (existing)
│   ├── host-adapter.ts
│   ├── llm-runner.ts
│   └── index.ts
├── standalone/                   # Standalone / Gateway-side adapter (existing)
│   ├── host-adapter.ts
│   ├── llm-runner.ts
│   └── index.ts
├── docs/                         # This documentation
│   ├── architecture.md
│   ├── adaptation-guide.md
│   └── platform-comparison.md
└── index.ts                      # Top-level barrel

MemoryCore/dify-plugin/           # Dify plugin (Python)
└── memory_tencentdb_dify/
    ├── types.py                  # Python type definitions
    ├── gateway_client.py         # Python HTTP client
    ├── base_adapter.py           # Python MemoryAdapterBase
    ├── provider.py               # Dify provider + tools
    └── __init__.py
```

## 9. Gateway v3 API Endpoints

All adapters communicate with the same Gateway endpoints:

| Endpoint | Method | Purpose | Layer |
|----------|--------|---------|-------|
| `/v3/memories/search` | POST | Search L1 structured memories | L1 |
| `/v3/conversations/add` | POST | Record L0 conversation messages | L0 |
| `/v3/conversations/search` | POST | Search L0 raw conversations | L0 |
| `/v3/persona` | GET | Read L3 persona content | L3 |
| `/v3/scenes` | GET | List L2 scene navigation | L2 |
| `/v3/scenes/{id}` | GET | Read a single L2 scene block | L2 |
| `/health` | GET | Gateway health check | — |

### Tenancy Headers

All v3 requests include tenancy headers for isolation:

```
X-TDAI-Team-ID:  my-team
X-TDAI-Agent-ID: my-agent
X-TDAI-User-ID:  alice
```

## 10. Configuration Strategy

All adapters follow the same configuration precedence:

```mermaid
graph LR
    A["1. Programmatic config<br/>(constructor / initialize)"] --> B["2. Environment variables<br/>(TDAI_*)"]
    B --> C["3. Built-in defaults"]
    C --> D["Result"]

    style A fill:#4CAF50,color:#fff
    style B fill:#2196F3,color:#fff
    style C fill:#9E9E9E,color:#fff
```

### Common Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TDAI_GATEWAY_ENDPOINT` | `http://127.0.0.1:8420` | Gateway base URL |
| `TDAI_GATEWAY_API_KEY` | *(none)* | Bearer token |
| `TDAI_GATEWAY_SERVICE_ID` | `default` | Multi-tenant service ID |
| `TDAI_GATEWAY_TIMEOUT_MS` | `10000` | Request timeout |
| `TDAI_TEAM_ID` | `default` | Team (tenant) identifier |
| `TDAI_AGENT_ID` | `default` | Agent identifier |
| `TDAI_USER_ID` | `default` | User identifier |
| `TDAI_CAPTURE_ENABLED` | `true` | Enable L0 capture |
| `TDAI_RECALL_MAX_RESULTS` | `5` | Max L1 memories per recall |
| `TDAI_RECALL_INCLUDE_PERSONA` | `true` | Include L3 in recall |
| `TDAI_RECALL_INCLUDE_SCENE_NAV` | `true` | Include L2 in recall |
