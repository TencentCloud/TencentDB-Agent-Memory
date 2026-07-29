# Platform Adapter Architecture

This document answers the **基础 (foundational)** acceptance goal of issue #235:
draw the architecture that connects the core memory engine (`TdaiCore`) to each
platform adapter, and annotate the data flow. It also describes the **拓展
(challenge)** goal: a unified adapter SDK where a new platform is integrated by
implementing a single interface.

## 1. Layered architecture

```mermaid
flowchart TB
  subgraph Hosts["Agent platforms (hosts)"]
    OC["OpenClaw plugin"]
    HM["Hermes provider (Python)"]
    CC["Claude Code hooks"]
    NX["Any new coding agent<br/>(Codex / Cursor / Continue ...)"]
  end

  subgraph SDK["Unified coding-agent adapter SDK<br/>(src/adapters/coding-agent)"]
    IFACE["CodingAgentPlatformAdapter&lt;TInput&gt;<br/>toEvent() + renderRecall()"]
    RUN["runCodingAgentAdapter()<br/>lifecycle · timeouts · auth · fail-open"]
    GC["CodingAgentGatewayClient<br/>HTTP transport"]
  end

  GW["TDAI Gateway (HTTP API)<br/>/recall /capture /search /session/end /health"]
  CORE["TdaiCore<br/>recall · capture · search"]
  STORE["L0 → L1 → L2 → L3 storage<br/>(local, no external API)"]

  OC -->|in-process| CORE
  HM -->|HTTP| GW
  CC -->|implements| IFACE
  NX -.->|implements| IFACE
  IFACE --> RUN --> GC -->|HTTP| GW
  GW --> CORE --> STORE
```

- **OpenClaw** embeds `TdaiCore` in-process (no HTTP hop).
- **Hermes** and every **coding-agent** host reach the core through the
  Gateway sidecar over HTTP, so the core never has to know the host.
- **Claude Code** is the reference implementation of the SDK interface. A new
  platform only implements the same interface (dotted arrow) and reuses the
  entire SDK runner + transport unchanged.

## 2. Unified adapter interface (拓展 goal)

A new platform is integrated by implementing one interface — no new transport,
timeout, auth, or error-handling code:

```ts
export interface CodingAgentPlatformAdapter<TInput> {
  readonly platform: string;
  // Map a platform-native payload into a neutral lifecycle event.
  toEvent(input: TInput): CodingAgentEvent | Promise<CodingAgentEvent>;
  // Render recalled memory back into the platform's native response shape.
  renderRecall(context: string, input: TInput): unknown;
}
```

`runCodingAgentAdapter(adapter, input, options)` then drives the lifecycle:
it resolves the event, calls the Gateway, flattens recall context, renders the
platform response, and **always fails open** (exit code 0, error to stderr) so
memory being unavailable never blocks the host agent.

```mermaid
flowchart LR
  IN["platform payload"] --> TE["adapter.toEvent()"]
  TE --> EV{"event.kind"}
  EV -->|recall| R["client.recall()"] --> CB["combineRecallContext()"] --> RR["adapter.renderRecall()"] --> OUT["native response"]
  EV -->|capture| C["client.capture()"]
  EV -->|session-end| S["client.endSession()"]
  EV -->|health| H["client.health()"]
  EV -->|noop| N["exit 0"]
```

## 3. Recall data flow (before the model call)

```mermaid
sequenceDiagram
  participant Host as Host (e.g. Claude Code)
  participant SDK as runCodingAgentAdapter
  participant GW as TDAI Gateway
  participant Core as TdaiCore

  Host->>SDK: toEvent(payload) → {kind: recall, query, sessionKey}
  SDK->>GW: POST /recall {query, session_key}
  GW->>Core: recall(query, sessionKey)
  Core-->>GW: {prepend_context (L1), append_system_context (persona/scene)}
  GW-->>SDK: RecallResponse
  SDK->>SDK: combineRecallContext() → strip tool-guide, dedup
  SDK-->>Host: renderRecall(context) → native injection (additionalContext)
```

## 4. Capture + session flush data flow (after the turn)

```mermaid
sequenceDiagram
  participant Host as Host
  participant SDK as runCodingAgentAdapter
  participant GW as TDAI Gateway
  participant Core as TdaiCore

  Host->>SDK: toEvent(payload) → {kind: capture, turn}
  SDK->>GW: POST /capture {user_content, assistant_content, session_key, started_at}
  GW->>Core: capture(turn) → L0 record + schedule L1/L2/L3
  Core-->>GW: {l0_recorded}
  Note over Host,SDK: on session close
  Host->>SDK: toEvent(payload) → {kind: session-end, sessionKey}
  SDK->>GW: POST /session/end {session_key}
  GW->>Core: flush pending pipeline for session
```

## 5. Capability boundary (`TdaiCore`)

Every adapter maps onto the same core capabilities, nothing more:

| Capability | Gateway route | Purpose |
| --- | --- | --- |
| recall | `POST /recall` | Fetch dynamic L1 + stable persona/scene context for a turn |
| capture | `POST /capture` | Record an L0 turn and schedule L1→L3 extraction |
| search memories | `POST /search/memories` | Query distilled L1+ memories |
| search conversations | `POST /search/conversations` | Query raw L0 turns |
| session flush | `POST /session/end` | Flush the pipeline for a session |
| health | `GET /health` | Liveness / store readiness |

See [`platform-adapter-comparison.md`](./platform-adapter-comparison.md) for how
OpenClaw, Hermes, Claude Code, and Dify differ across these routes, and
[`coding-agent-adapter-quickstart.md`](./coding-agent-adapter-quickstart.md) for
the minimal code to onboard a new platform.
