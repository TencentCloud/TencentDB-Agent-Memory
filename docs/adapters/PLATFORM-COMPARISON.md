# Platform Adaptation Comparison — OpenClaw · Hermes · Claude Code · Dify

> 中文版本见 [PLATFORM-COMPARISON_CN.md](./PLATFORM-COMPARISON_CN.md)。
> Architecture context: [ARCHITECTURE.md](./ARCHITECTURE.md) · Onboarding: [NEW-PLATFORM-GUIDE.md](./NEW-PLATFORM-GUIDE.md)

Four platforms now integrate with the memory engine, through four *structurally different*
mechanisms. This document compares them dimension by dimension — the differences are exactly the
knowledge a fifth integration needs.

## 1. At a glance

| Dimension | OpenClaw plugin | Hermes provider | Claude Code (MCP) | Dify |
| --- | --- | --- | --- | --- |
| Integration mechanism | Plugin SDK, in-process (`index.ts register(api)`) | Python `MemoryProvider` + Node HTTP sidecar | MCP stdio server (`TdaiMcpServer`) | Inbound REST: External Knowledge API + Custom Tool |
| Direction of calls | Host calls plugin (hooks/tools) | Provider calls Gateway (outbound REST) | Client calls server (JSON-RPC over stdio) | **Dify calls us** (inbound REST) |
| Process model | Same process as host | 2 processes (agent + sidecar), supervisor-managed | Child process of Claude Code, 1 per session | Standalone HTTP service (`:8421`), N Dify apps → 1 adapter |
| Built on Adapter SDK | No (predates it) | No (predates it; wire reused by SDK) | **Yes** — `extends BasePlatformAdapter` | **Yes** — `extends BasePlatformAdapter` |
| Lifecycle events available | Rich hooks: `before_prompt_build`, `agent_end`, `before_message_write`, `gateway_stop` | Provider methods: `prefetch`, `sync_turn`, `handle_tool_call`, `on_session_end` | MCP requests only: `initialize`, `tools/list`, `tools/call` (+ stdin close) | Stateless HTTP requests only |
| Recall (read path) | **Automatic** — hook injects `prependContext` + `appendSystemContext` every turn | **Automatic** — `prefetch()` before each turn | **Model-invoked** — `memory_recall` / `memory_search` tools | **Pipeline-invoked** — Knowledge Retrieval node hits `POST /retrieval` |
| Capture (write path) | **Automatic** — `agent_end` hook | **Automatic** — `sync_turn()` on background thread | **Model-invoked** — `memory_capture` tool (+ optional Stop-hook recipe) | **Flow-invoked** — Custom Tool `POST /tools/capture` step |
| Session identity | Host's `sessionKey` (stable per conversation) | Hermes session → `session_key` on the wire | `TDAI_SESSION_KEY` env or `claude-code:<cwd basename>`; per-call override | `session_key` in tool body, else `dify:default`; conversation-scoped keys via flow variables |
| Auth story | None needed (same process) | Optional Bearer to Gateway (`TDAI_GATEWAY_API_KEY`) | Inherits transport auth (Bearer to Gateway) — stdio itself is local | Dual: Dify→adapter Bearer (`TDAI_DIFY_API_KEY`, Dify error codes 1001/1002) + adapter→Gateway Bearer |
| Failure isolation | try/catch in hooks; plugin errors surface in host logs | Circuit breaker + watchdog + background threads — agent never blocks | Tool errors → `isError: true` result (model sees it, session survives); `safeRecall`/`safeCapture` semantics | Dify-spec error bodies (`error_code`); `/health` never throws; engine failures → HTTP 500 with `error_msg` |
| LLM for extraction pipeline | Host's model runner (OpenClaw), overridable via `cfg.llm` | Standalone OpenAI-compatible config (`TDAI_LLM_*`) | Whatever the backing core/gateway is configured with (adapter itself never touches an LLM) | Same as Claude Code — adapter is LLM-free |
| Wire vocabulary | TypeScript camelCase (in-process) | snake_case JSON | snake_case tool args (matches gateway), camelCase inside SDK | snake_case JSON (Dify's own contract) |
| Approx. integration surface | ~900 lines (`index.ts`, hooks + tools + CLI + offload) | ~1,400 lines Python (provider + client + supervisor) | **~360 lines** on the SDK (protocol + tools + server) | **~380 lines** on the SDK (routes + OpenAPI) |

## 2. What each mechanism is good at

### OpenClaw — deep in-process hooks
The richest integration: recall and capture are invisible and automatic, tools are registered
natively, and the plugin can even patch prompt assembly (`before_message_write`). The cost is
maximal coupling — it needs the host's plugin SDK, its config format, its logger, and its LLM
runner. This is the right shape when the host *offers* a plugin system with lifecycle hooks.

### Hermes — sidecar REST with supervised lifecycle
Proves the engine works cross-language: Python never links Node code, it just speaks 6 REST
routes. All robustness lives client-side (supervisor spawns/monitors the gateway, circuit breaker
sheds load on repeated failures, capture runs on daemon threads). The cost is operational: two
processes, port management, health polling. This is the right shape when the platform is
not Node and turns are high-frequency.

### Claude Code — MCP tools, model-in-the-loop
The inversion of OpenClaw: instead of hooks making memory invisible to the model, the *model
itself* decides when to recall/capture via tools. Integration cost is tiny (stdio, no ports, no
auth) and the same server binary serves any MCP client — but memory quality now depends on the
model's tool discipline (mitigated by good tool descriptions, and optionally restored to
automatic via a Claude Code `Stop` hook that POSTs `/capture`; see the
[adapter README](../../src/adapters/claude-code/README.md)).

### Dify — inbound contract, zero client code
The only platform where **we implement someone else's API** rather than calling our own: Dify
defines `POST /retrieval` (External Knowledge Base API) and imports our OpenAPI spec as a Custom
Tool. Nothing runs inside Dify; a no-code user wires memory into a flow graphically. The cost:
read path is retrieval-shaped (per-record `content`/`score`, hence the SDK's structured `items`),
and session identity must be threaded through flow variables explicitly.

## 3. Decision drivers, distilled

| If the new platform… | …then copy this pattern |
| --- | --- |
| has a plugin SDK with prompt/turn hooks | OpenClaw (in-process transport; hooks → `safeRecall`/`safeCapture`) |
| is non-Node or wants process isolation | Hermes (http transport against the Gateway) |
| speaks MCP (Claude Code, Cursor, Codex, Zed, …) | Claude Code adapter — often reusable **as-is**, just change `TDAI_SESSION_KEY` |
| defines its own inbound retrieval/tool contract | Dify (implement their contract over `MemoryClient`) |
| is a plain REST consumer you control | Skip an adapter entirely — call the Gateway directly, like the Hermes client does |

Two structural axes explain every row above:

1. **Who initiates?** Hooks (platform → adapter, automatic) vs tools (model → adapter,
   discretionary) vs inbound API (platform → adapter, flow-configured). Automatic paths give
   consistent memory but need lifecycle hooks; tool paths work everywhere but depend on the model.
2. **Where does the core run?** In-process (lowest latency, one lifecycle owner) vs gateway
   sidecar (language-agnostic, shared by many consumers). The SDK makes this a config flag
   (`TDAI_ADAPTER_TRANSPORT`), not an architecture decision — the same MCP or Dify adapter runs
   in either mode unchanged.

## 4. Before/after the SDK

Before the SDK, each integration re-derived: wire mapping (camelCase⇄snake_case), the
`CompletedTurn` default-messages rule, error taxonomy, degradation policy, env conventions, and
core lifecycle. That is why Hermes needed ~1,400 lines. With the SDK, the Claude Code and Dify
adapters each ship in under 400 lines, and **none of those lines touch anything below
`MemoryClient`** — the "one interface" claim of the 拓展 tier, verified by their unit tests which
run against a fake `MemoryClient` with no core, no gateway, no network.
