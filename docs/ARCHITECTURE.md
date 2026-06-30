# TencentDB Agent Memory Architecture

> Cross-Platform Adapter SDK Architecture and Design

---

## Table of Contents

- [Overview](#overview)
- [System Architecture](#system-architecture)
- [Core Components](#core-components)
- [Platform Adapter SDK](#platform-adapter-sdk)
- [Data Flow](#data-flow)
- [Platform Implementations](#platform-implementations)

---

## Overview

TencentDB Agent Memory provides a **layered memory system** for AI agents, supporting multiple platform integrations through a unified **Adapter SDK**. This architecture enables seamless onboarding of new platforms with minimal code changes.

**Key Design Goals:**
1. **Platform Agnostic** — Any agent platform can integrate by implementing the `PlatformAdapter` interface
2. **Layered Memory** — L0→L1→L2→L3 semantic pyramid for progressive memory abstraction
3. **Symbolic Short-term** — Mermaid canvas for context compression with full traceability

---

## System Architecture

```mermaid
flowchart TB
    subgraph Platforms["Agent Platforms"]
        OC["OpenClaw"]
        HM["Hermes"]
        CC["Claude Code"]
        Custom["Custom Platform"]
    end

    subgraph AdapterSDK["Adapter SDK Layer"]
        PA["PlatformAdapter Interface"]
        BA["BaseAdapter Abstract Class"]
        TR["ToolRegistry"]
        LM["LifecycleManager"]
    end

    subgraph Adapters["Platform Adapters (implement SDK)"]
        OC_Ad["OpenClawAdapter"]
        HM_Ad["HermesAdapter"]
        CC_Ad["ClaudeCodeAdapter"]
    end

    subgraph Core["TdaiCore Engine"]
        Recall["Memory Recall"]
        Capture["Memory Capture"]
        Search["Memory Search"]
        Extract["Memory Extraction"]
    end

    subgraph Storage["Storage Layer"]
        SQLite["SQLite + sqlite-vec"]
        TCVDB["Tencent Cloud VDB"]
        Files["Layered Files (L0-L3)"]
    end

    OC --> OC_Ad
    HM --> HM_Ad
    CC --> CC_Ad
    Custom -->|"implement"| PA

    OC_Ad -.->|"extends"| BA
    HM_Ad -.->|"extends"| BA
    CC_Ad -.->|"extends"| BA

    OC_Ad -.->|"implements"| PA
    HM_Ad -.->|"implements"| PA
    CC_Ad -.->|"implements"| PA

    BA --> PA
    BA --> TR
    BA --> LM

    OC_Ad --> Core
    HM_Ad --> Core
    CC_Ad --> Core

    Core --> SQLite
    Core --> TCVDB
    Core --> Files
```

### Architecture Layers

| Layer | Description | Components |
|-------|-------------|------------|
| **Platform** | Agent hosting environments | OpenClaw, Hermes, Claude Code, Custom |
| **Adapter SDK** | Unified integration interface | `PlatformAdapter`, `BaseAdapter`, `ToolRegistry`, `LifecycleManager` |
| **TdaiCore** | Core memory engine | Recall, Capture, Search, Extraction |
| **Storage** | Persistence backends | SQLite, Tencent Cloud VDB, Layered Files |

---

## Core Components

### 1. TdaiCore Engine

The central memory processing engine that handles:

```mermaid
flowchart LR
    subgraph Input["Input Events"]
        Turn["Agent Turn"]
        Query["Search Query"]
        Tool["Tool Call"]
    end

    subgraph TdaiCore["TdaiCore"]
        Recall["handleBeforeRecall"]
        Capture["handleTurnCommitted"]
        Search["searchMemories"]
        Extract["extractMemories"]
    end

    subgraph Output["Output"]
        Injection["Memory Injection"]
        Results["Search Results"]
        Storage["Layered Storage"]
    end

    Turn --> Capture
    Query --> Search
    Tool --> Extract
    Recall --> Injection
    Search --> Results
    Extract --> Storage
```

**Core Methods:**
| Method | Description | Trigger |
|--------|-------------|---------|
| `handleBeforeRecall()` | Inject relevant memories before agent responds | `before_model` / `before_prompt_build` |
| `handleTurnCommitted()` | Capture and process agent turn | `agent_end` / `after_model` |
| `searchMemories()` | Full-text and semantic search | On-demand tool call |
| `extractMemories()` | Progressive extraction L0→L1→L2→L3 | Periodic / threshold-based |

### 2. Memory Layering

```mermaid
graph TB
    subgraph Pyramid["Memory Pyramid"]
        L3["L3 Persona<br/>(User Profile)"]
        L2["L2 Scenario<br/>(Scene Blocks)"]
        L1["L1 Atom<br/>(Atomic Facts)"]
        L0["L0 Conversation<br/>(Raw Dialogue)"]
    end

    L3 -->|"derive from"| L2
    L2 -->|"aggregate"| L1
    L1 -->|"extract from"| L0

    style L3 fill:#fef3c7,stroke:#f59e0b,stroke-width:2px
    style L2 fill:#dbeafe,stroke:#3b82f6,stroke-width:2px
    style L1 fill:#dcfce7,stroke:#22c55e,stroke-width:2px
    style L0 fill:#f1f5f9,stroke:#64748b,stroke-width:2px
```

| Layer | Content | Format | Purpose |
|-------|---------|--------|---------|
| **L0** | Raw dialogue | Markdown | Evidence preservation |
| **L1** | Atomic facts | JSON | Semantic retrieval |
| **L2** | Scene blocks | Markdown | Contextual coherence |
| **L3** | User persona | Markdown | Personalization |

---

## Platform Adapter SDK

### SDK Design Philosophy

The SDK follows the **Adapter Pattern** to provide a unified interface while allowing platform-specific implementations:

```
┌─────────────────────────────────────────────────────────────────┐
│                    PlatformAdapter Interface                      │
│  (Contract: implement this to add a new platform)                │
├─────────────────────────────────────────────────────────────────┤
│  + platform: PlatformInfo           // Platform metadata        │
│  + getRuntimeContext(): Context     // Runtime environment      │
│  + createLLMRunnerFactory(): Factory // LLM integration          │
│  + registerHooks(core): void        // Event lifecycle hooks     │
│  + registerTools(core, reg): void   // Agent tool registration   │
│  + initialize(): Promise<void>      // Async setup               │
│  + shutdown(): Promise<void>         // Cleanup                   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ implements
         ┌────────────────────┼────────────────────┐
         │                    │                    │
   ┌─────┴─────┐      ┌──────┴─────┐      ┌──────┴─────┐
   │OpenClaw   │      │  Hermes    │      │Claude Code │
   │Adapter    │      │  Adapter   │      │  Adapter   │
   └───────────┘      └────────────┘      └────────────┘
```

### Directory Structure

```
src/adapters/
├── sdk/                    # The unified Adapter SDK
│   ├── index.ts           # SDK exports
│   ├── interface.ts       # PlatformAdapter interface
│   ├── types.ts           # Type definitions
│   ├── base-adapter.ts    # BaseAdapter abstract class
│   ├── tool-registry.ts   # Tool registration utility
│   └── lifecycle-manager.ts # Lifecycle utilities
│
├── openclaw/              # OpenClaw adapter implementation
│   └── index.ts
│
├── hermes/                # Hermes adapter implementation
│   └── index.ts
│
└── claude-code/           # Claude Code adapter (planned)
    └── index.ts
```

### Interface Definition

```typescript
/**
 * Unified Platform Adapter Interface
 * 
 * Implement this interface to add support for a new agent platform.
 * The SDK provides BaseAdapter for common functionality.
 */
export interface PlatformAdapter {
  /** Platform metadata */
  readonly platform: PlatformInfo;

  /** Get runtime environment context */
  getRuntimeContext(): RuntimeContext;

  /** Create LLM runner factory for this platform */
  createLLMRunnerFactory(): LLMRunnerFactory;

  /** Register event lifecycle hooks */
  registerHooks(core: TdaiCore): void;

  /** Register agent tools via registry */
  registerTools(core: TdaiCore, registry: ToolRegistry): void;

  /** Initialize adapter resources */
  initialize(): MaybePromise<void>;

  /** Cleanup adapter resources */
  shutdown(): MaybePromise<void>;
}

/**
 * Platform capability descriptor
 */
export interface PlatformInfo {
  readonly name: string;           // Platform identifier
  readonly version: string;         // Adapter version
  readonly description: string;     // Human-readable description
  readonly capabilities: Capability[];
}

/**
 * Supported memory capabilities
 */
export type Capability =
  | 'memory-recall'        // Pre-turn memory injection
  | 'memory-capture'       // Turn capture and processing
  | 'memory-search'        // On-demand semantic search
  | 'conversation-search'  // Historical conversation search
  | 'session-management';  // Session lifecycle
```

### BaseAdapter Abstract Class

```typescript
/**
 * Base adapter providing common functionality
 * 
 * Extend this class to implement a new platform adapter.
 * Override only the methods that differ from the platform.
 */
export abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformInfo;

  constructor(protected config: MemoryTdaiConfig) {}

  /** Default hook registration - captures turns and triggers recall */
  registerHooks(core: TdaiCore): void {
    core.on('beforePromptBuild', async () => {
      await core.handleBeforeRecall();
    });
    core.on('agentEnd', async (turn) => {
      await core.handleTurnCommitted(turn);
    });
  }

  /** Default tool registration - memory search tools */
  registerTools(core: TdaiCore, registry: ToolRegistry): void {
    registry.register('tdai_memory_search', async (params) => {
      return core.searchMemories(params);
    });
    registry.register('tdai_conversation_search', async (params) => {
      return core.searchConversations(params);
    });
  }

  // Abstract methods to implement:
  abstract getRuntimeContext(): RuntimeContext;
  abstract createLLMRunnerFactory(): LLMRunnerFactory;
  abstract initialize(): MaybePromise<void>;
  abstract shutdown(): MaybePromise<void>;
}
```

---

## Data Flow

### Memory Recall Flow

```mermaid
sequenceDiagram
    participant Agent as Agent (Platform)
    participant Adapter as Platform Adapter
    participant Core as TdaiCore
    participant Store as Storage Layer

    Agent->>Adapter: before_prompt_build event
    Adapter->>Core: handleBeforeRecall()
    
    Core->>Store: Query L3/L2/L1 memories
    Store-->>Core: Ranked memory results
    
    Core->>Core: Format injection context
    Core-->>Adapter: Memory injection payload
    Adapter-->>Agent: Injected context
    
    Note over Agent: Agent responds with context awareness
```

### Memory Capture Flow

```mermaid
sequenceDiagram
    participant Agent as Agent (Platform)
    participant Adapter as Platform Adapter
    participant Core as TdaiCore
    participant Extract as Extraction Pipeline
    participant Store as Storage Layer

    Agent->>Adapter: agent_end event (turn data)
    Adapter->>Core: handleTurnCommitted(turn)
    
    Core->>Extract: Trigger extraction
    
    alt Short-term (L0)
        Extract->>Store: Persist raw turn
    end
    
    alt Long-term (L1→L2→L3)
        Extract->>Extract: Progressive distillation
        Extract->>Store: Update L1/L2/L3
    end
    
    Store-->>Core: Confirmation
    Core-->>Adapter: Extraction complete
```

### Symbolic Short-term Compression Flow

```mermaid
flowchart TB
    subgraph Before["Before Compression"]
        Raw["Raw Tool Logs<br/>(100K+ tokens)"]
    end

    subgraph Process["Compression Pipeline"]
        Offload["Context Offload"]
        Mermaid["Mermaid Canvas Generation"]
    end

    subgraph After["After Compression"]
        Canvas["Mermaid Canvas<br/>(~500 tokens)"]
        Refs["refs/*.md<br/>(offloaded files)"]
    end

    Raw -->|"1. Offload"| Offload
    Offload -->|"2. Extract relations"| Mermaid
    Offload -->|"3. Store raw"| Refs
    Mermaid -->|"4. Inject"| Canvas

    style Raw fill:#fee2e2,stroke:#ef4444
    style Canvas fill:#dcfce7,stroke:#22c55e
    style Refs fill:#f1f5f9,stroke:#64748b
```

---

## Platform Implementations

### OpenClaw Adapter

| Aspect | Implementation |
|--------|---------------|
| **Event System** | OpenClaw plugin hooks (`before_prompt_build`, `agent_end`) |
| **LLM Integration** | OpenClaw built-in model |
| **Data Directory** | `~/.openclaw/memory-tdai/` |
| **Tool Registration** | OpenClaw tool API |

### Hermes Adapter

| Aspect | Implementation |
|--------|---------------|
| **Event System** | Hermes Gateway HTTP callbacks |
| **LLM Integration** | Standalone LLM (via env config) |
| **Data Directory** | `~/.hermes/memory-tdai/` |
| **Tool Registration** | Hermes Python tool decorator |

### Claude Code Adapter (Planned)

| Aspect | Implementation |
|--------|---------------|
| **Event System** | Claude Code CLI hooks |
| **LLM Integration** | Claude API |
| **Data Directory** | `~/.claude/memory-tdai/` |
| **Tool Registration** | Claude Code tool format |

---

## Extension Guide

### Adding a New Platform

1. **Create adapter directory**: `src/adapters/<platform>/`
2. **Extend BaseAdapter**: Inherit common functionality
3. **Implement PlatformAdapter**: Fulfill the interface contract
4. **Register hooks**: Map platform events to TdaiCore methods
5. **Test integration**: Verify memory capture and recall

See [ADAPTER_GUIDE.md](./ADAPTER_GUIDE.md) for detailed implementation steps.

---

## Related Documentation

- [Adapter Integration Guide](./ADAPTER_GUIDE.md)
- [Main README](../README.md)
- [Contributing Guide](../CONTRIBUTING.md)
