# Dify Adapter Architecture

The Dify adapter is intentionally thin. It does not embed memory logic and does
not call an LLM directly. It maps Dify tool invocations onto the existing
TencentDB Agent Memory Gateway API.

## Call Chain

```text
Dify workflow
  -> Dify tool plugin
  -> TdaiGatewayClient
  -> TencentDB Agent Memory Gateway
  -> TdaiCore
  -> L0/L1/L2/L3 memory pipeline and stores
```

## Responsibilities

| Layer | Responsibility |
| --- | --- |
| Dify workflow | Supplies `conversation_id`, user text, assistant text, and decides where recalled context is injected. |
| Dify tool plugin | Validates tool parameters, truncates prompt-bound output, and returns non-throwing JSON payloads. |
| `TdaiGatewayClient` | Sends JSON requests to Gateway endpoints and normalizes HTTP failures for the Python plugin runtime. |
| Gateway | Owns HTTP auth, request validation, session flush, recall, capture, and search routes. |
| `TdaiCore` | Owns host-neutral memory orchestration and the progressive memory pipeline. |

## Scope Boundary

`TdaiGatewayClient` in this directory is a Dify-runtime transport shim, not a
new shared adapter SDK. It mirrors the existing Gateway HTTP contract so the
Python plugin runtime can call the same endpoints as other platform adapters
without duplicating memory logic inside Dify.

The shared Gateway client shape belongs to the Gateway Client Adapter Kit
tracked separately from this Dify plugin. Dify keeps only the minimal Python
transport required by the Dify plugin runtime.

## Recall Flow

1. Dify calls `tdai_recall` before an LLM node.
2. The plugin sends `POST /recall` with `query` and `session_key`.
3. Gateway calls `TdaiCore.handleBeforeRecall`.
4. The plugin returns `{ "ok": true, "context": "..." }`.
5. The Dify workflow injects `context` into the LLM prompt.

## Read Paths

- `tdai_conversation_search` is the immediate `L0 read path`. It queries
  `POST /search/conversations` and can read the raw captured turn right after
  `tdai_capture` succeeds.
- `tdai_recall` is the structured recall path. It depends on the existing
  Gateway/Core consolidation pipeline and may return an empty `context`
  immediately after a single captured turn.

## Capture Flow

1. Dify calls `tdai_capture` after the assistant response is available.
2. The plugin sends `POST /capture` with the user message, assistant response,
   and the same `session_key`.
3. Gateway calls `TdaiCore.handleTurnCommitted`.
4. L0 conversation capture happens synchronously; downstream extraction is
   scheduled by the existing core pipeline.

## Session Model

Use Dify `conversation_id` as `session_key`. Do not use Dify run IDs because
they change between workflow executions and would fragment memory.

The current Gateway request types accept `user_id`, but core isolation still
follows the existing Gateway behavior. Treat `session_key` as the primary Dify
isolation key until Gateway/Core user scoping is extended.

## Credential Validation

`GET /health` is intentionally unauthenticated. To verify Bearer credentials,
the provider validation path sends one read-only memory search request:

```text
POST /search/memories
query = "__dify_credential_validation__"
limit = 1
```

This does not write memory, but it can appear in Gateway logs, traces, or
metrics. A future Gateway `OPTIONS` or authenticated handshake endpoint could
replace this probe without changing the tool API.
