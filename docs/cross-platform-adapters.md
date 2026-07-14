# Cross-Platform Memory Adapter Architecture

```mermaid
flowchart TB
  subgraph Host["Agent hosts"]
    OpenClaw["OpenClaw<br/>plugin hooks and tools"]
    Hermes["Hermes Agent<br/>memory_tencentdb provider"]
    NewHosts["New adapters<br/>Claude Code / Codex / Dify / OpenCode"]
  end

  subgraph Adapter["Adapter layer"]
    OpenClawAdapter["OpenClawHostAdapter<br/>OpenClawLLMRunner"]
    HermesClient["Hermes Gateway client<br/>prefetch / sync_turn / search"]
    PlatformBridge["MemoryPlatformBridge<br/>runtime + turn normalization"]
    AdapterSDK["Cross-platform Adapter SDK<br/>MemoryPlatformAdapter + MemoryGatewayClient"]
    Gateway["TDAI Gateway HTTP API<br/>/recall /capture /search /session/end /seed"]
    StandaloneAdapter["StandaloneHostAdapter<br/>StandaloneLLMRunner"]
  end

  subgraph Core["Host-neutral memory core"]
    TdaiCore["TdaiCore facade<br/>handleBeforeRecall<br/>handleTurnCommitted<br/>searchMemories<br/>searchConversations"]
    Pipeline["Memory pipeline<br/>L0 Conversation -> L1 Atom -> L2 Scene -> L3 Persona"]
    Search["Retrieval and tools<br/>hybrid search / memory search / conversation search"]
  end

  subgraph Runtime["Runtime services"]
    LLM["LLM runner<br/>OpenClaw embedded or OpenAI-compatible API"]
    Store[("Memory storage<br/>SQLite + sqlite-vec or TCVDB<br/>Markdown scene/persona files")]
  end

  OpenClaw -->|"before_prompt_build<br/>agent_end<br/>tdai_* tools"| OpenClawAdapter
  Hermes -->|"provider calls"| HermesClient
  NewHosts -->|"host-specific events"| PlatformBridge
  PlatformBridge --> AdapterSDK

  HermesClient -->|"HTTP JSON"| Gateway
  AdapterSDK -->|"HTTP JSON"| Gateway
  Gateway --> StandaloneAdapter

  OpenClawAdapter --> TdaiCore
  StandaloneAdapter --> TdaiCore

  TdaiCore -->|"recall/search"| Search
  TdaiCore -->|"capture/session end"| Pipeline
  Pipeline --> Store
  Search --> Store
  Pipeline -->|"L1/L2/L3 extraction"| LLM
  TdaiCore -->|"context + tool results"| OpenClaw
  Gateway -->|"context + search results"| HermesClient
  Gateway -->|"context + search results"| AdapterSDK

  classDef host fill:#f8fafc,stroke:#64748b,color:#0f172a
  classDef adapter fill:#ecfeff,stroke:#0891b2,color:#164e63
  classDef core fill:#f0fdf4,stroke:#16a34a,color:#14532d
  classDef runtime fill:#fff7ed,stroke:#ea580c,color:#7c2d12

  class OpenClaw,Hermes,NewHosts host
  class OpenClawAdapter,HermesClient,PlatformBridge,AdapterSDK,Gateway,StandaloneAdapter adapter
  class TdaiCore,Pipeline,Search core
  class LLM,Store runtime
```

## Boundary Summary

- `TdaiCore` is the stable host-neutral boundary. New platforms should not call pipeline internals directly.
- OpenClaw runs in-process through `OpenClawHostAdapter`; Hermes and future hosts should use the Gateway path unless they can safely embed Node and provide a `HostAdapter`.
- The cross-platform adapter SDK should normalize host events into four gateway operations: recall, capture, memory search, and conversation search.
- Platform-specific packages should stay thin: identity/session mapping, prompt injection, lifecycle hooks, and optional tool registration.
