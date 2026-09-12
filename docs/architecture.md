# Architecture Overview

This document is the single authoritative reference for how TencentDB-Agent-Memory is structured internally and how each platform adapter plugs into the core engine. Individual platform setup guides live alongside this doc; come here first to understand the overall design.

**Platform setup guides:** [Claude Code](./claude-code-adapter.md) · [Cursor](./cursor-adapter.md) · [Codex CLI](./codex-adapter.md) · [Dify / n8n](./dify-adapter.md)

**Adding a platform:** [new-platform-guide.md](./new-platform-guide.md)

---

## Full Platform Overview

```
 ┌──────────────┐  ┌──────────────────────────────┐  ┌─────────────────┐  ┌─────────────┐  ┌─────────────┐
 │  OpenClaw    │  │           Hermes             │  │  Claude Code    │  │   Cursor    │  │  Codex CLI  │
 │   Agent      │  │         (Python)             │  │    Agent        │  │    Agent    │  │   Agent     │
 └──────┬───────┘  └──────────────┬───────────────┘  └────────┬────────┘  └──────┬──────┘  └──────┬──────┘
        │                         │                            │                  │                 │
 transport:               transport:                   transport:          transport:         transport:
 in-process               HTTP POST                    MCP stdio           MCP stdio          MCP stdio
 SDK hooks                localhost:8420               JSON-RPC            JSON-RPC           JSON-RPC
        │                         │                            │                  │                 │
        │          ┌──────────────▼────────────┐              │                  │                 │
        │          │   Node.js Gateway          │              │                  │                 │
        │          │   StandaloneHostAdapter    │              │                  │                 │
        │          └──────────────┬────────────┘              │                  │                 │
        │                         │                            │                  │                 │
 capture:                 capture:                     capture:            capture:           capture:
 agent_end hook           sync_turn()                  Stop hook           tdai_memory        tdai_memory
 (automatic)              (automatic)                  (automatic)         _capture tool      _capture tool
        │                         │                            │           (explicit)          (explicit)
        └─────────────────────────┴────────────────────────────┴──────────────────┴─────────────────┘
                                                               │
                                                    ┌──────────▼──────────┐
                                                    │      TdaiCore        │
                                                    │  ┌────────────────┐  │
                                                    │  │ L0  Raw Turns  │  │
                                                    │  │ L1  Atoms      │  │
                                                    │  │ L2  Scenes     │  │
                                                    │  │ L3  Persona    │  │
                                                    │  └────────────────┘  │
                                                    └──────────┬──────────┘
                                                               │
                                              ┌────────────────┴───────────────┐
                                              │                                 │
                                     ┌────────▼────────┐               ┌───────▼───────┐
                                     │  SQLite-vec     │               │ TencentDB     │
                                     │  (local)        │               │ VectorDB      │
                                     └─────────────────┘               └───────────────┘
```

---

## Memory Layers (L0 → L3)

The engine organises all conversational data into a four-layer semantic pyramid. Lower layers preserve raw evidence; upper layers preserve structure.

```
                        ┌──────────────────┐
              L3        │   User Persona   │  preferences, habits, identity
                        └────────┬─────────┘
                                 │ distilled from
                        ┌────────▼─────────┐
              L2        │  Scene Blocks    │  recurring contexts, topic clusters
                        └────────┬─────────┘
                                 │ extracted from
                        ┌────────▼─────────┐
              L1        │  Episodic Atoms  │  discrete facts, skills, instructions
                        └────────┬─────────┘
                                 │ structured from
                        ┌────────▼─────────┐
              L0        │  Raw Turns       │  verbatim user ↔ assistant exchanges
                        └──────────────────┘
```

**Write path:** every captured turn lands in L0 first. A scheduler then runs L1 extraction (per N turns), L2 scene inference (per N L1 atoms), and L3 persona synthesis (periodically). All pipelines are asynchronous and non-blocking — the adapter does not wait for them.

**Read path:** `handleBeforeRecall` queries L1 atoms and the L3 persona, merges them into a context string, and returns it to the adapter to prepend to the system prompt. L0 is only queried explicitly via `searchConversations`.

---

## Core Engine: TdaiCore

`TdaiCore` is the host-neutral memory engine. It exposes five operations that every adapter calls:

| Method | When to call | What it does |
|---|---|---|
| `handleBeforeRecall(query, sessionKey)` | Start of every turn | Queries L1 + L3, returns formatted context |
| `handleTurnCommitted(turn)` | End of every turn | Writes L0, schedules L1/L2/L3 pipelines |
| `searchMemories(params)` | On demand | Searches L1 atoms with optional type/scene filters |
| `searchConversations(params)` | On demand | Searches L0 raw history, optionally scoped to a session |
| `handleSessionEnd(sessionKey)` | Conversation ends | Flushes pending L1/L2/L3 pipelines for the session |

`TdaiCore` depends only on a `HostAdapter` and a parsed config — it has no knowledge of any specific platform.

Adapters do not call these methods directly. Both transport base classes go through
`MemoryOperations` (`src/adapters/memory-operations.ts`), a transport-neutral facade that
owns argument validation, the `TdaiCore` call and timing logs. Only the wire format differs
between transports — MCP renders markdown for an LLM, HTTP emits JSON — so an operation added
to the facade reaches every platform on both transports at once.

---

## Adapter Model

### The HostAdapter Contract

Every platform must provide one class that implements `HostAdapter`:

```typescript
interface HostAdapter {
  readonly hostType: string;         // platform identifier
  getRuntimeContext(): RuntimeContext; // session + user identity
  getLogger(): Logger;
  getLLMRunnerFactory(): LLMRunnerFactory;
}

interface RuntimeContext {
  userId: string;
  sessionKey: string;   // groups turns into a named conversation
  sessionId: string;    // sub-session (can equal sessionKey)
  platform: string;
  dataDir: string;
  workspaceDir: string;
}
```

The adapter bridges three things: **identity** (who is the user, what is the session), **logging** (where do diagnostic messages go), and **LLM access** (which model runs the extraction pipelines).

### General Data Flow

```
  Platform runtime
       │
       │  trigger (hook / HTTP call / MCP tool)
       ▼
  Adapter layer
  ┌──────────────────────────────────────────────┐
  │  translate platform event → TdaiCore call    │
  │  translate TdaiCore result → platform format │
  └──────────────────────────────────────────────┘
       │
       │  handleBeforeRecall / handleTurnCommitted / search*
       ▼
  TdaiCore
  ┌──────────────────────────────────────────────┐
  │  L0 write → L1/L2/L3 pipeline scheduling     │
  │  L1 + L3 recall → context string             │
  └──────────────────────────────────────────────┘
       │
       ▼
  Storage (SQLite-vec local  /  TencentDB VectorDB)
```

---

## Platform Adapters

### 1 · OpenClaw (in-process TypeScript plugin)

```
┌──────────────────────────────────────────────────────┐
│  OpenClaw Agent process                               │
│                                                       │
│  ┌─────────────┐   before_prompt_build hook           │
│  │   OpenClaw  │──────────────────────────────────┐  │
│  │   runtime   │   agent_end hook                 │  │
│  └─────────────┘──────────────────────────────┐   │  │
│                                               │   │  │
│  ┌────────────────────────────────────────┐   │   │  │
│  │  index.ts  (plugin entry)              │   │   │  │
│  │    OpenClawHostAdapter                 │◄──┘   │  │
│  │    TdaiCore                            │◄──────┘  │
│  └────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────┘
```

**Transport:** in-process function calls — no network, no subprocess.

**Recall trigger:** `before_prompt_build` SDK hook fires automatically before each prompt assembly. The adapter calls `handleBeforeRecall` and injects the returned context into the prompt.

**Capture trigger:** `agent_end` SDK hook fires automatically when the agent finishes a turn. The adapter calls `handleTurnCommitted`.

**LLM runner:** `OpenClawLLMRunnerFactory` wraps the OpenClaw agent's own LLM runtime (`api.runtime.agent`), so the extraction pipelines reuse the same model connection that the agent itself uses.

**Session key:** taken from the OpenClaw session context passed to each hook invocation.

**Key files:**
```
src/adapters/openclaw/
├── host-adapter.ts   # OpenClawHostAdapter
├── llm-runner.ts     # OpenClawLLMRunnerFactory (wraps OpenClaw's LLM API)
└── index.ts          # barrel + OpenClaw plugin registration
index.ts              # plugin entry point (registers hooks with OpenClaw SDK)
```

---

### 2 · Hermes / HTTP Gateway (Python provider + Node.js sidecar)

```
┌──────────────────────┐          ┌───────────────────────────────────────┐
│  Hermes Agent        │          │  Node.js Gateway sidecar (port 8420)  │
│  (Python process)    │          │                                       │
│                      │          │  ┌───────────────────────────────┐   │
│  ┌────────────────┐  │  HTTP    │  │  TdaiGateway                  │   │
│  │MemoryProvider  │──┼─────────►│  │  (extends HttpServerBase)     │   │
│  │  prefetch()    │  │  POST    │  │  StandaloneHostAdapter        │   │
│  │  sync_turn()   │◄─┼──────── │  │  TdaiCore                     │   │
│  └────────────────┘  │  JSON    │  └───────────────────────────────┘   │
│                      │          └───────────────────────────────────────┘
│  GatewaySupervisor   │  (spawns the Gateway on startup, health-checks it)
└──────────────────────┘
```

**Transport:** HTTP POST — the Python provider (`memory_tencentdb/`) sends JSON requests to the Node.js Gateway over localhost. The `GatewaySupervisor` manages the Gateway subprocess lifetime.

**Recall trigger:** `prefetch()` — Hermes calls this before each agent turn. The provider sends a `POST /recall` to the Gateway.

**Capture trigger:** `sync_turn()` — called after each completed turn. The provider sends a `POST /capture` to the Gateway.

**LLM runner:** `StandaloneLLMRunnerFactory` — calls any OpenAI-compatible API (configured via env vars). The Gateway process owns its own LLM connection.

**Session key:** passed in from Hermes session kwargs at `initialize()`.

**Key files:**
```
hermes-plugin/memory/memory_tencentdb/
├── __init__.py       # MemoryProvider (prefetch, sync_turn, initialize, shutdown)
├── client.py         # HTTP client for all Gateway endpoints
└── supervisor.py     # GatewaySupervisor (spawns + health-checks the Gateway)

src/adapters/standalone/
├── host-adapter.ts   # StandaloneHostAdapter (32 lines: adds `platform` option)
├── llm-runner.ts     # StandaloneLLMRunnerFactory (OpenAI-compatible API)
└── index.ts          # barrel

src/gateway/
├── server.ts         # TdaiGateway (extends HttpServerBase; /seed in handleCustomRoute)
├── config.ts         # loadGatewayConfig — YAML + env vars → GatewayConfig
└── types.ts          # Request/response types for all Gateway HTTP endpoints
```

---

### 2a · Dify Plugin (HTTP)

```
┌────────────────────────┐          ┌───────────────────────────────┐
│  Dify Workflow / Agent │          │  Node.js Dify sidecar         │
│                        │  HTTP    │  (port 8420 by default)       │
│  ┌──────────────────┐  │  POST    │  ┌───────────────────────┐   │
│  │ HTTP Request node│──┼─────────►│  │  DifyHttpServer       │   │
│  │ /recall, /capture│◄─┼──────── │  │  (extends HttpServer  │   │
│  └──────────────────┘  │  JSON   │  │   Base)               │   │
│                        │          │  │  DifyHostAdapter      │   │
└────────────────────────┘          │  │  TdaiCore             │   │
                                    │  └───────────────────────┘   │
                                    └───────────────────────────────┘
```

**Transport:** HTTP POST — same API surface as the Hermes Gateway. Dify uses built-in "HTTP Request" nodes to call `/recall` and `/capture`.

**Key files:**
```
src/adapters/dify/
├── host-adapter.ts   # DifyHostAdapter (9 lines: 2 members)
├── http-server.ts    # DifyHttpServer  (12 lines: extends HttpServerBase)
├── types.ts          # type aliases
└── index.ts          # barrel

bin/
├── tdai-dify-http.ts   # entry point (start DifyHttpServer from env vars)
└── tdai-dify-http.mjs  # launcher (runs .ts via tsx)
```

---

### 3 · MCP Adapters (Claude Code + Cursor + Codex CLI)

All three MCP adapters share the same transport and tool surface. They differ only in session identity and capture trigger.

```
  Claude Code                    Cursor                       Codex CLI
  ┌──────────────┐               ┌──────────────┐             ┌──────────────┐
  │ Agent        │               │ Composer /   │             │ Agent task   │
  │ (per session)│               │ Agent        │             │ (per session)│
  └──────┬───────┘               └──────┬───────┘             └──────┬───────┘
         │ MCP stdio JSON-RPC           │ MCP stdio JSON-RPC         │ MCP stdio JSON-RPC
         ▼                              ▼                             ▼
  ┌──────────────────────┐      ┌──────────────────────┐    ┌──────────────────────┐
  │ ClaudeCodeMcpServer  │      │   CursorMcpServer    │    │   CodexMcpServer     │
  │ (extends McpServer   │      │ (extends McpServer   │    │ (extends McpServer   │
  │  Base + hook queue)  │      │  Base, no extras)    │    │  Base, no extras)    │
  └──────────┬───────────┘      └──────────┬───────────┘    └──────────┬───────────┘
             │                             │                            │
             └──────────────┬──────────────┘                           │
                            │                                           │
                            └───────────────────┬───────────────────────┘
                                                │ McpServerBase
                                                │ (shared JSON-RPC + 5 tools)
                                                ▼
                                       ┌─────────────────┐
                                       │    TdaiCore     │
                                       └─────────────────┘

  ── Stop hook (Claude Code only) ──────────────────────────────────
  Claude Code runtime
      │  fires tdai-capture-hook after every response
      ▼
  tdai-capture-hook (short-lived process)
      │  appends turn to hook-queue.jsonl
      ▼
  ClaudeCodeMcpServer.drainHookQueue()
      │  rename → parse → handleTurnCommitted × N
      ▼
  TdaiCore
```

**Transport:** MCP JSON-RPC 2.0 over stdio. One server process per agent session (Claude Code, Codex) or per workspace (Cursor).

**MCP tools exposed:**

| Tool | Triggered by |
|---|---|
| `tdai_memory_recall` | LLM, at the start of each turn |
| `tdai_memory_capture` | LLM, after each response (manual mode) |
| `tdai_memory_search` | LLM, on demand |
| `tdai_conversation_search` | LLM, on demand |
| `tdai_session_end` | LLM, when the conversation ends — flushes pending L1/L2/L3 pipelines |

**Capture trigger (Claude Code):** automatic via Stop hook (`tdai-capture-hook`) — the hook writes to `hook-queue.jsonl`; the MCP server drains it before each recall and on a 30-second background timer. An explicit `tdai_memory_capture` call also works but **must not be combined with the Stop hook** (double-write).

**Capture trigger (Cursor / Codex CLI):** explicit only — the LLM calls `tdai_memory_capture` as instructed by the Cursor Rule / Codex system prompt. Neither Cursor nor Codex has a Stop hook equivalent.

**LLM runner:** `StandaloneLLMRunnerFactory` (same as Hermes/Gateway) — calls any OpenAI-compatible API.

**Session key:**

| Platform | Default | Override |
|---|---|---|
| Claude Code | `CLAUDE_CODE_SESSION_ID` env (set by Claude Code) | explicit `session_key` arg |
| Cursor | UUID stable for server process lifetime | `TDAI_SESSION_KEY` env or explicit arg |
| Codex CLI | UUID (Codex does not set a per-session env var) | `CODEX_SESSION_ID` or `TDAI_SESSION_KEY` env |

**Shared MCP infrastructure:**

```
src/adapters/
├── utils.ts                   # makeStderrLogger (shared)
├── mcp-host-adapter-base.ts   # McpHostAdapterBase — constructor, RuntimeContext,
│                              #   getLogger, getLLMRunnerFactory, getDataDir, …
│                              #   Abstract: hostType, platformId, resolveSessionKey()
├── mcp-server-base.ts         # McpServerBase — full MCP JSON-RPC machinery,
│                              #   4 tool implementations, lifecycle management
│                              #   Hooks: onAfterInit / onBeforeRecall / onBeforeShutdown

├── claude-code/
│   ├── host-adapter.ts        # ClaudeCodeHostAdapter (11 lines: 3 overrides)
│   ├── mcp-server.ts          # ClaudeCodeMcpServer (adds hook queue)
│   ├── types.ts               # type aliases → base types
│   └── index.ts
├── cursor/
│   ├── host-adapter.ts        # CursorHostAdapter (11 lines: 3 overrides)
│   ├── mcp-server.ts          # CursorMcpServer (thin: createAdapter only)
│   ├── types.ts               # type aliases → base types
│   └── index.ts
└── codex/
    ├── host-adapter.ts        # CodexHostAdapter (11 lines: 3 overrides)
    ├── mcp-server.ts          # CodexMcpServer (thin: createAdapter only)
    ├── types.ts               # type aliases → base types
    └── index.ts
```

**Shared HTTP infrastructure** (symmetric to MCP for HTTP/Plugin platforms):

```
src/adapters/
├── host-adapter-base.ts       # HostAdapterBase — shared by ALL platforms:
│                              #   getRuntimeContext, getLogger, getLLMRunnerFactory
│                              #   Abstract: hostType, platformId
├── memory-operations.ts       # MemoryOperations — transport-neutral facade over
│                              #   TdaiCore: validation + the 5 operations, shared
│                              #   by McpServerBase and HttpServerBase
├── http-server-base.ts        # HttpServerBase — http.Server + TdaiCore,
│                              #   6 standard endpoints (health/recall/capture/search×2/session/end),
│                              #   auth (Bearer) + CORS, lifecycle management
│                              #   Hooks: onAfterInit / onBeforeShutdown /
│                              #          handleCustomRoute / buildMemoryConfig

├── standalone/
│   ├── host-adapter.ts        # StandaloneHostAdapter (32 lines: adds `platform` option)
│   └── …
├── dify/
│   ├── host-adapter.ts        # DifyHostAdapter (9 lines: 2 members)
│   ├── http-server.ts         # DifyHttpServer  (12 lines: createAdapter only)
│   ├── types.ts               # type aliases → base types
│   └── index.ts
└── …
```

HTTP adapters extend `HostAdapterBase` directly — there is no separate HTTP
adapter base, because HTTP platforms need nothing beyond the shared behaviour.
`McpHostAdapterBase` is that same class plus default-session-key resolution,
which only stdio needs (one session per process).

**Identity is not tenancy.** `TdaiCore` reads only `dataDir` from
`RuntimeContext`; `userId`, `sessionKey` and `platform` are recorded but do not
scope storage. A single HTTP server therefore shares one memory store across
all callers, and the endpoints deliberately expose no `user_id` field. Per-user
isolation would require threading a user id through `TdaiCore` into the L0–L3
storage paths and vector-store filters.

---

## Full Platform Comparison

| | OpenClaw | Hermes / Gateway | Dify Plugin | Claude Code MCP | Cursor MCP | Codex CLI MCP |
|---|---|---|---|---|---|---|
| **Language** | TypeScript | Python + TypeScript | TypeScript | TypeScript | TypeScript | TypeScript |
| **Transport** | In-process SDK hooks | HTTP (localhost) | HTTP (localhost) | MCP stdio JSON-RPC | MCP stdio JSON-RPC | MCP stdio JSON-RPC |
| **Process model** | Same process as agent | Python provider + Node.js sidecar | Node.js sidecar | Subprocess per session | One server per workspace | Subprocess per session |
| **Recall trigger** | `before_prompt_build` (automatic) | `prefetch()` (automatic) | HTTP Request node (workflow) | `tdai_memory_recall` tool (LLM) | `tdai_memory_recall` tool (LLM) | `tdai_memory_recall` tool (LLM) |
| **Capture trigger** | `agent_end` (automatic) | `sync_turn()` (automatic) | HTTP Request node (workflow) | Stop hook (auto) or tool | `tdai_memory_capture` tool | `tdai_memory_capture` tool |
| **Session key source** | OpenClaw session ctx | Hermes session kwargs | Request body | `CLAUDE_CODE_SESSION_ID` env | `TDAI_SESSION_KEY` or UUID | `CODEX_SESSION_ID` env or UUID |
| **LLM runner** | OpenClawLLMRunner (in-agent) | StandaloneLLMRunner | StandaloneLLMRunner | StandaloneLLMRunner | StandaloneLLMRunner | StandaloneLLMRunner |
| **Config format** | `openclaw.plugin.json` | `plugin.yaml` + env | env vars (`TDAI_*`) | `.claude/settings.json` | `~/.cursor/mcp.json` | `~/.codex/config.toml` |
| **Memory instructions** | Plugin config | Plugin config | Dify workflow nodes | `.claude/CLAUDE.md` | `.cursor/rules/*.mdc` | Codex system prompt |
| **Infrastructure** | None | Gateway subprocess | Dify sidecar subprocess | None | None | None |
| **Recall reliability** | Always (hook-driven) | Always (code-driven) | Always (workflow-driven) | Depends on LLM following instructions | Depends on LLM following instructions | Depends on LLM following instructions |
| **Capture reliability** | Always (hook-driven) | Always (code-driven) | Always (workflow-driven) | High (Stop hook) or LLM-dependent | LLM-dependent | LLM-dependent |
| **Added in** | v0.1 | v0.2 | v0.3.7 | v0.3.6 | v0.3.6 | v0.3.6 |

### When to use which

- **OpenClaw** — you are running OpenClaw and want zero-configuration memory with automatic recall and capture.
- **Hermes** — you are running a Hermes-based Python agent and want memory via the Gateway sidecar; OpenClaw is not available.
- **Dify** — you are building a Dify workflow or agent and want deterministic memory via HTTP Request nodes; no LLM instruction needed for recall/capture.
- **Claude Code** — you are using Claude Code CLI/IDE extension and want persistent memory across coding sessions. Use the Stop hook for automatic capture.
- **Cursor** — you are using Cursor and are comfortable adding a Cursor Rule that instructs the LLM to call the memory tools explicitly.
- **Codex CLI** — you are using OpenAI Codex CLI and want persistent memory; configure via `~/.codex/config.toml` with instructions in the system prompt.

---

## Capture Reliability at a Glance

```
Reliability →   Low                               High
                │                                   │
  Cursor        ├── LLM may skip capture ──────────►│
  Codex CLI     ├── LLM may skip capture ──────────►│
  Claude Code   │   (with Stop hook) ───────────────►│
  Dify          │                    ────────────────►│ workflow-driven, always fires
  Hermes        │                    ────────────────►│ code-driven, always fires
  OpenClaw      │                    ────────────────►│ hook-driven, always fires
```

The MCP adapters rely on the LLM following instructions in CLAUDE.md / Cursor Rules. This introduces a failure mode — the LLM may skip a capture under token pressure or instruction override. The Stop hook mitigates this for Claude Code by capturing outside the LLM loop entirely. OpenClaw, Hermes, and Dify are fully deterministic because capture is initiated by code or workflow nodes, not by the model.

---

## Adding a New MCP Platform

The shared base classes make adding a new MCP-based platform (e.g. Windsurf, Zed, Amp) a ~25-line exercise:

**1. Host adapter** (`src/adapters/{platform}/host-adapter.ts`, ~11 lines):

```typescript
import { McpHostAdapterBase, sessionKeyFromEnv } from "../mcp-host-adapter-base.js";

export class WindsurfHostAdapter extends McpHostAdapterBase {
  readonly hostType = "windsurf" as const;
  protected readonly platformId = "windsurf";

  protected resolveSessionKey(explicit: string | undefined): string {
    return sessionKeyFromEnv(explicit, "WINDSURF_SESSION_ID");
  }
}
```

**2. MCP server** (`src/adapters/{platform}/mcp-server.ts`, ~10 lines):

```typescript
import { McpServerBase } from "../mcp-server-base.js";
import { WindsurfHostAdapter } from "./host-adapter.js";

export class WindsurfMcpServer extends McpServerBase {
  protected createAdapter() {
    return new WindsurfHostAdapter({ ...this.opts, logger: this.logger });
  }
}
```

**3.** Add `types.ts` (2-line aliases), `index.ts` (3-line barrel), a `bin/tdai-{platform}-mcp.ts` entry point (copy `bin/tdai-cursor-mcp.ts`, change class name and default data dir), and wire into `src/adapters/index.ts` + `package.json`.

---

## Adding a New HTTP Platform

The `HostAdapterBase` + `HttpServerBase` pair makes adding a new HTTP/Plugin platform (e.g. n8n, Coze, FastGPT) equally cheap — the Dify adapter is 21 lines total:

**1. Host adapter** (`src/adapters/{platform}/host-adapter.ts`, ~9 lines):

```typescript
import { HostAdapterBase } from "../host-adapter-base.js";
import type { HostAdapterBaseOptions } from "../host-adapter-base.js";

export class N8nHostAdapter extends HostAdapterBase {
  readonly hostType = "n8n" as const;
  protected readonly platformId = "n8n";
}
```

**2. HTTP server** (`src/adapters/{platform}/http-server.ts`, ~10 lines):

```typescript
import { HttpServerBase } from "../http-server-base.js";
import { N8nHostAdapter } from "./host-adapter.js";

export class N8nHttpServer extends HttpServerBase {
  protected createAdapter() {
    return new N8nHostAdapter({ ...this.opts, logger: this.logger });
  }
}
```

**3.** Add `types.ts` (2-line aliases), `index.ts` (3-line barrel), `bin/tdai-n8n-http.ts` (copy `bin/tdai-dify-http.ts`, change class name and default port), `bin/tdai-n8n-http.mjs` launcher, and wire into `src/adapters/index.ts` + `package.json`.

The 6 standard endpoints (`/recall`, `/capture`, `/search/memories`, `/search/conversations`, `/session/end`, `/health`) and all auth/CORS logic are inherited. Custom endpoints go in `handleCustomRoute()`.

The entry point reads all configuration from `TDAI_*` env vars via `bin/shared-http.ts` — no config file needed.
