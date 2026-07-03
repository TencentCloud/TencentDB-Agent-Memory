# TDAI Memory — Core Engine & Adapter Architecture

> Deliverable for [issue #235](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235).
> This document maps the host-neutral memory core and every platform adapter,
> and annotates the read (recall) and write (capture) data flows.

## 1. The big picture

TDAI separates **memory algorithms** from **the host that consumes them**. One
engine (`TdaiCore`) is reached two ways: **in-process** (OpenClaw) or across an
**HTTP boundary** (the Gateway, used by Hermes and — new in this work — the MCP
and Dify adapters).

```mermaid
flowchart TB
    subgraph hosts["Agent platforms"]
        OC["OpenClaw<br/>(index.ts plugin)"]
        HM["Hermes<br/>(Python MemoryProvider)"]
        MCP["Claude Code / Codex / Cursor<br/>(MCP server) — NEW"]
        DIFY["Dify<br/>(OpenAPI custom tool) — NEW"]
    end

    subgraph sdk["Unified Adapter SDK (src/sdk) — NEW"]
        GC["TdaiGatewayClient"]
        MA["MemoryAdapter + GatewayMemoryAdapter"]
        BT["buildMemoryTools()"]
    end

    subgraph gw["TDAI Gateway (src/gateway) — HTTP boundary"]
        GWS["TdaiGateway HTTP server<br/>/recall /capture /search/* /session/end"]
    end

    subgraph core["TDAI Core (host-neutral)"]
        TC["TdaiCore<br/>recall · capture · search · flush"]
        HA["HostAdapter interface"]
        subgraph stores["Storage & pipeline"]
            ST["IMemoryStore<br/>(SQLite-vec / TCVDB)"]
            EM["EmbeddingService"]
            PM["MemoryPipelineManager<br/>L0→L1→L2→L3"]
        end
    end

    OC -->|"OpenClawHostAdapter (in-process)"| TC
    HM --> GWS
    MCP --> MA
    DIFY -->|"direct HTTP"| GWS
    MA --> GC --> GWS
    BT -.builds tools for.-> MCP
    GWS -->|"StandaloneHostAdapter"| TC
    TC --> HA
    TC --> ST & EM & PM

    style sdk fill:#e6f3ff,stroke:#0366d6
    style MCP fill:#e6ffe6,stroke:#28a745
    style DIFY fill:#e6ffe6,stroke:#28a745
```

Everything above the Gateway is a **thin translator**; everything from the
Gateway down is the shared engine.

## 2. Core engine capabilities (`TdaiCore`)

`src/core/tdai-core.ts` is the single facade both integration styles call. It
depends only on abstract interfaces (`HostAdapter`, `LLMRunner`), never on a
concrete host.

| Method | Kind | Purpose | OpenClaw event | Hermes / Gateway |
| :----- | :--- | :------ | :------------- | :--------------- |
| `handleBeforeRecall(text, sessionKey)` | read | Retrieve memory context for a turn | `before_prompt_build` hook | `prefetch()` → `POST /recall` |
| `handleTurnCommitted(turn)` | write | Persist a turn, trigger the pipeline | `agent_end` hook | `sync_turn()` → `POST /capture` |
| `searchMemories(params)` | read | Search L1 structured memories | `tdai_memory_search` tool | `POST /search/memories` |
| `searchConversations(params)` | read | Search L0 raw dialogue | `tdai_conversation_search` tool | `POST /search/conversations` |
| `handleSessionEnd(sessionKey)` | write | Flush one session's buffered work | (process exit → `destroy`) | `on_session_end` → `POST /session/end` |
| `initialize()` / `destroy()` | lifecycle | Bring up / tear down stores & scheduler | plugin load / `gateway_stop` | Gateway start / stop |

### The host-neutral seam: `HostAdapter`

`TdaiCore` asks the host only three questions (`src/core/types.ts`):

- **Who is the user/session?** → `getRuntimeContext(): RuntimeContext`
- **How do I call an LLM?** → `getLLMRunnerFactory(): LLMRunnerFactory`
- **Where do I log?** → `getLogger(): Logger`

Two implementations exist today: `OpenClawHostAdapter` (wraps the OpenClaw
plugin API, runs the LLM in-process) and `StandaloneHostAdapter` (Gateway;
OpenAI-compatible HTTP LLM calls). **The new adapters do not add a third** —
they sit above the Gateway, which already uses `StandaloneHostAdapter`.

### The four memory layers

`handleTurnCommitted` feeds a background pipeline (`MemoryPipelineManager`):

```mermaid
flowchart LR
    L0["L0<br/>raw conversation<br/>(l0-recorder)"] -->|extract + dedup| L1["L1<br/>structured memories<br/>(l1-extractor)"]
    L1 -->|scene clustering| L2["L2<br/>scene blocks<br/>(scene-extractor)"]
    L2 -->|synthesis| L3["L3<br/>persona<br/>(persona-generator)"]
    L0 -. vector index .-> ST[("Vector store<br/>+ embeddings")]
    L1 -. vector index .-> ST
```

Reads hit L0/L1 (search) and L1+L3 (recall); writes land in L0 and cascade
upward asynchronously.

## 3. Existing adapter #1 — OpenClaw (in-process)

`index.ts` is the OpenClaw Plugin SDK entry. It constructs an
`OpenClawHostAdapter` + `TdaiCore` **in the same process** and bridges OpenClaw
events to core methods.

```mermaid
sequenceDiagram
    participant U as User
    participant OCP as OpenClaw plugin (index.ts)
    participant Core as TdaiCore (in-process)
    participant Store as Vector store / pipeline

    Note over OCP: register tools + hooks on load
    U->>OCP: prompt
    OCP->>Core: before_prompt_build → handleBeforeRecall()
    Core->>Store: vector + BM25 search (L1), read L3 persona
    Store-->>Core: memories + persona
    Core-->>OCP: RecallResult (prepend / appendSystemContext)
    OCP-->>U: LLM answer (memory-primed)
    U->>OCP: (turn ends)
    OCP->>Core: agent_end → handleTurnCommitted()
    Core->>Store: record L0, notify scheduler (async L1→L2→L3)
    Note over OCP,Core: gateway_stop → core.destroy()
```

- **Coupling:** deep — hooks into `before_prompt_build` / `agent_end`, registers
  `tdai_memory_search` + `tdai_conversation_search` tools, shares the LLM runner.
- **Transport:** none (direct method calls).
- **Language:** TypeScript.

## 4. Existing adapter #2 — Hermes (HTTP provider)

The Gateway (`src/gateway/server.ts`) re-exposes `TdaiCore` over HTTP. Hermes
runs a **Python** `MemoryProvider` that speaks to it via a small HTTP client.

```mermaid
sequenceDiagram
    participant HA as Hermes Agent
    participant P as MemoryTencentdbProvider (Python)
    participant C as SdkClient (urllib)
    participant GW as TdaiGateway (HTTP)
    participant Core as TdaiCore

    HA->>P: prefetch(query)
    P->>C: recall()
    C->>GW: POST /recall
    GW->>Core: handleBeforeRecall()
    Core-->>GW: RecallResult
    GW-->>C: {context, strategy, memory_count}
    C-->>P: dict
    P-->>HA: "## Memory\n<context>"
    HA->>P: sync_turn(user, assistant)  %% background thread
    P->>C: capture() → POST /capture → handleTurnCommitted()
```

- **Coupling:** medium — implements Hermes's `MemoryProvider` (prefetch,
  sync_turn, handle_tool_call, tool schemas, session end).
- **Transport:** HTTP to a **managed Gateway sidecar** the provider can spawn,
  health-check, and auto-resurrect (circuit breaker + watchdog).
- **Language:** Python (client) + TypeScript (Gateway).

## 5. New adapters (this work) — MCP & Dify via the unified SDK

The Gateway boundary is the natural extension point for any non-OpenClaw host.
This work distills that boundary into a reusable **SDK** (`src/sdk/`) and builds
two adapters on top:

```mermaid
flowchart LR
    subgraph new["src/sdk — one interface to implement / consume"]
        direction TB
        MA["MemoryAdapter<br/>(recall · search · capture · flush)"]
        GMA["GatewayMemoryAdapter (HTTP)"]
        GC["TdaiGatewayClient<br/>(timeouts · retries · auth · typed errors)"]
        BT["buildMemoryTools()<br/>neutral tool descriptors"]
        GMA -->|implements| MA
        GMA --> GC
        BT -->|consumes| MA
    end

    MCP["MCP server<br/>(src/adapters/mcp)"] -->|maps tools→JSON-RPC| BT
    DIFY["Dify OpenAPI<br/>(src/adapters/dify)"] -.->|calls Gateway directly| GC
    GC --> GW[("TDAI Gateway")]
```

- **MCP adapter** (`src/adapters/mcp/`): a pure JSON-RPC 2.0 stdio server that
  turns `buildMemoryTools()` output into MCP tools. One server → Claude Code,
  Codex, Cursor, Cline, Windsurf.
- **Dify adapter** (`src/adapters/dify/`): a declarative OpenAPI schema Dify
  imports; Dify calls the Gateway directly (the SDK client documents the exact
  contract).

Both reuse the same Gateway and store as OpenClaw and Hermes — one memory,
many platforms. See [`COMPARISON.md`](./COMPARISON.md) for the trade-offs and
[`ADDING-A-PLATFORM.md`](./ADDING-A-PLATFORM.md) for the recipe.
