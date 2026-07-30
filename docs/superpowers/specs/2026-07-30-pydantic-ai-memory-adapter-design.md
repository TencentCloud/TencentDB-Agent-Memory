# PydanticAI Adapter for TencentDB Agent Memory

## Status

- Date: 2026-07-30
- Issue: [TencentCloud/TencentDB-Agent-Memory#235](https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/235)
- Target: the issue's intermediate acceptance level, with architecture comparison and production-oriented tests
- Selected approach: an independent Python adapter that communicates with the existing TencentDB Agent Memory Gateway

## Purpose

Add PydanticAI as a new supported agent platform without coupling Python code to the TypeScript `TdaiCore` implementation. The adapter shall:

1. recall relevant TencentDB Agent Memory context before each PydanticAI run;
2. inject that context as run-scoped instructions;
3. capture a successful user/assistant turn after the run;
4. expose explicit memory and conversation search tools to the agent;
5. end a memory session explicitly;
6. support both asynchronous and synchronous PydanticAI applications;
7. keep the agent usable when the memory service is temporarily unavailable by default.

The adapter is intended to produce a real, verifiable open-source contribution. Documentation and application materials must describe only behavior demonstrated by committed code and test evidence.

## Scope and Acceptance Boundary

Issue #235 defines progressive acceptance levels. This contribution implements one new platform, so it claims the **intermediate** level:

- a functioning PydanticAI adapter;
- basic memory recall and capture;
- explicit search and session lifecycle integration;
- automated tests;
- an offline example and a real DeepSeek example;
- architecture, usage, security, and best-practice documentation.

The documentation compares OpenClaw, Hermes, and PydanticAI integration patterns, but the contribution does not claim the deep level's implementation of two new platforms. It also does not claim the extended level's unified multi-platform SDK.

## Alternatives Considered

### A. Independent Python Gateway adapter — selected

Create a small Python package under `pydantic-ai-plugin/`. It wraps a PydanticAI `Agent` and calls the existing Gateway HTTP API.

Benefits:

- follows the repository's established Python integration lane;
- leaves `TdaiCore` and the current OpenClaw/Hermes adapters unchanged;
- supports remote or separately managed Gateway deployments;
- can be tested with a fake Gateway and PydanticAI offline models;
- keeps the platform boundary explicit.

Cost: the Gateway process must be running.

### B. PydanticAI `ProcessHistory` or capability integration

Modify model message history through PydanticAI's deeper lifecycle APIs.

This offers tighter framework integration, but is more sensitive to PydanticAI lifecycle changes. History processors may run more than once within one agent run, making exactly-once recall and capture harder to reason about. It also risks persisting retrieved context into application history.

### C. MCP-only integration

Expose TencentDB memory exclusively as MCP tools.

This is broadly reusable, but tool invocation is model-controlled. It cannot guarantee recall before every run or capture after every successful run, so it does not meet the selected automatic lifecycle behavior.

## Architecture

The adapter is an independent Python package:

```text
PydanticAI application
        |
        v
TencentDBMemoryAgent
  | recall before run
  | run-scoped instructions
  | per-run search tools
  | capture after success
  | explicit session end
        |
        v
GatewayClient
  | HTTP JSON
  | optional Bearer authentication
        |
        v
Existing TdaiGateway
        |
        v
Existing TdaiCore and L0-L3 memory pipeline
```

No changes are required to `TdaiCore`, the Gateway route contract, the OpenClaw adapter, or the Hermes provider.

### Platform comparison

| Platform | Integration boundary | Recall | Capture | Session end |
| --- | --- | --- | --- | --- |
| OpenClaw | TypeScript in-process host adapter | host lifecycle hook to `TdaiCore` | committed-turn hook | host session hook |
| Hermes | Python provider over Gateway HTTP | provider prefetch | provider turn sync | shutdown/session method |
| PydanticAI | Python agent wrapper over Gateway HTTP | before `Agent.run` | after successful result | explicit wrapper method |

This design intentionally follows the Gateway lane used by Python consumers while mapping lifecycle events to PydanticAI rather than copying Hermes-specific supervisor behavior.

## Package Layout

```text
pydantic-ai-plugin/
  pyproject.toml
  README.md
  README_CN.md
  src/
    memory_tencentdb_pydantic_ai/
      __init__.py
      agent.py
      client.py
      errors.py
      identity.py
      serialization.py
      tools.py
  examples/
    offline_memory_demo.py
    deepseek_memory_demo.py
  tests/
    fake_gateway.py
    test_agent.py
    test_client.py
    test_identity.py
    test_serialization.py
```

The root npm package's `files` list will include `pydantic-ai-plugin/`, and the English and Chinese root READMEs will link to the corresponding adapter documentation.

### Component responsibilities

- `client.py`: typed request/response boundary for `/recall`, `/capture`, `/search/memories`, `/search/conversations`, `/session/end`, and `/health`.
- `errors.py`: stable adapter exceptions that distinguish connection, HTTP, and response-decoding failures.
- `identity.py`: validates `user_id` and `session_id` and derives a deterministic session key.
- `serialization.py`: converts text and structured PydanticAI outputs into a stable UTF-8 JSON-compatible string for capture.
- `tools.py`: creates per-run memory and conversation search tools bound to the current user and session.
- `agent.py`: coordinates recall, PydanticAI execution, capture, sync/async parity, and explicit session end.

Each component can be tested without a real LLM or TencentDB deployment.

## Public API

The primary API wraps an existing PydanticAI agent:

```python
from pydantic_ai import Agent
from memory_tencentdb_pydantic_ai import GatewayClient, TencentDBMemoryAgent

agent = Agent("deepseek:deepseek-v4-flash")
memory_agent = TencentDBMemoryAgent(
    agent=agent,
    client=GatewayClient(
        base_url="http://127.0.0.1:8420",
        api_key=None,
    ),
    strict=False,
)

result = await memory_agent.run(
    "我喜欢喝无糖咖啡，请记住。",
    user_id="student-001",
    session_id="demo-session",
)

await memory_agent.end_session(
    user_id="student-001",
    session_id="demo-session",
)
```

The wrapper exposes:

- `run(...)`: asynchronous lifecycle integration;
- `run_sync(...)`: synchronous lifecycle integration;
- `end_session(...)` and `end_session_sync(...)`, both returning the Gateway's `flushed` boolean;
- the wrapped agent through a read-only `agent` property;
- `strict=False` by default, with `strict=True` for fail-fast memory behavior.

The wrapper returns the original PydanticAI run result instead of introducing a replacement result type.

The first release accepts text user prompts. It safely serializes text or structured model output for capture. Full multimodal prompt capture is explicitly out of scope.

## Identity Model

Every run requires non-empty `user_id` and `session_id` values. The default session key is:

```text
pydantic-ai:{percent-encoded-user-id}:{percent-encoded-session-id}
```

Callers may provide an explicit `session_key` when migrating an existing application. Percent encoding prevents ambiguous keys when identifiers contain separators.

`user_id` provides memory provenance and `session_key` provides a retrieval boundary. Neither value is an authentication or tenant-authorization mechanism; applications must enforce authorization before calling the adapter.

## Run Data Flow

For each `run` or `run_sync` call:

1. Validate the identity and derive the session key.
2. Call Gateway `/recall` with the user prompt, user ID, and session key.
3. Convert a non-empty recalled context into run-scoped PydanticAI instructions.
4. Create a per-run toolset containing `memory_search` and `conversation_search`, bound to the current identity.
5. Call the original PydanticAI agent, preserving caller-supplied instructions, dependencies, message history, model settings, usage limits, and other supported keyword arguments.
6. If the model call succeeds, serialize its output and call Gateway `/capture` exactly once.
7. Return the original PydanticAI result.

Recall context is not appended to persistent message history. Run-scoped instructions keep retrieved memory separate from durable application history and preserve the caller's existing static and runtime instructions.

When the caller supplies runtime instructions or toolsets, the wrapper appends the recalled instructions and memory toolset instead of replacing them. A conflicting caller-defined tool named `memory_search` or `conversation_search` is rejected with a clear configuration error rather than being silently overwritten.

If the PydanticAI call raises, the exception propagates unchanged and capture is not attempted.

### Explicit search tools

The per-run toolset exposes:

- `memory_search(query, limit=5, memory_type=None, scene=None)`;
- `conversation_search(query, limit=5)`.

Tool descriptions state that search is for relevant long-term memory or prior conversation evidence. Results are normalized into compact structured data so the model does not have to interpret Gateway transport details.

These tools supplement automatic recall; they do not replace it.

### Session end

The adapter does not infer session end from an individual run. Applications explicitly call `end_session` or `end_session_sync`, which maps to Gateway `/session/end`.

## Gateway Client

`GatewayClient` is a small synchronous client with asynchronous counterparts implemented without requiring a second HTTP dependency. Its configuration includes:

- `base_url`, defaulting to `http://127.0.0.1:8420`;
- optional `api_key`;
- finite connection/read timeout;
- a small retry count for safe operations.

The client validates that `base_url` has an HTTP or HTTPS scheme, a host, and no embedded username, password, query, or fragment.

The API key is sent only as `Authorization: Bearer <key>`. Secrets are never included in `repr`, logs, or exception messages.

## Failure Semantics

The adapter defines:

- `GatewayConnectionError`;
- `GatewayHTTPError`;
- `GatewayResponseError`.

Default `strict=False` behavior:

- recall failure: log a warning and run the agent without recalled context;
- search-tool failure: return a structured “memory service unavailable” tool result;
- capture failure: log a warning and preserve the successful model result;
- session-end failure: log a warning and return `False`.

With `strict=True`, memory errors propagate instead of being converted to fallback behavior. PydanticAI/model exceptions always propagate regardless of this setting.

Retry rules:

- retry only transient connection failures and server responses for safe read or flush operations;
- do not retry authentication failures or other client errors;
- do not automatically retry `/capture`, because the current Gateway contract has no idempotency key and a retry could create duplicate memory.

Every request uses a finite timeout. Warning logs include the operation and endpoint but never the Bearer token or complete user content.

## Security

- Localhost without authentication is supported for local development.
- Non-loopback deployments should enable `TDAI_GATEWAY_API_KEY` and use HTTPS directly or through a trusted reverse proxy.
- The adapter does not treat user-controlled identity fields as authorization.
- Examples read secrets from environment variables.
- `.env`, keys, captured conversations, and generated local state are not committed.
- The DeepSeek example reads `DEEPSEEK_API_KEY`; it never asks the user to paste the key into source code or terminal history.

## Testing Strategy

Tests use the standard library `unittest` framework plus PydanticAI's offline model facilities. They require no network credentials.

### Pure unit tests

- reject empty identity values;
- generate stable, collision-resistant default session keys;
- preserve explicit session-key overrides;
- serialize strings and structured outputs deterministically;
- redact secrets from client representations and errors.

### Fake Gateway integration tests

An in-process HTTP server records requests and returns controlled responses. Tests verify:

- correct endpoint, method, JSON payload, and Bearer header;
- recall, capture, both search endpoints, session end, and health;
- Unicode content;
- invalid JSON and malformed response handling;
- authentication and other HTTP errors;
- timeouts and transient failures;
- no automatic retry for capture.

### PydanticAI lifecycle tests

Using `TestModel` or `FunctionModel`, tests verify:

- recalled context is injected exactly once per run;
- existing instructions and message history remain available;
- both search tools are available with the current identity;
- successful output is captured exactly once;
- model failure causes no capture;
- capture failure preserves the model result in fail-open mode;
- strict mode propagates memory errors;
- async and sync entry points have equivalent behavior;
- structured output is captured in stable serialized form;
- explicit session end reaches the Gateway.

### Repository validation

Before publication, run:

```text
python -m unittest discover -s pydantic-ai-plugin/tests -v
python -m build pydantic-ai-plugin
npm test
npm run build
npm pack --dry-run
```

The packed npm file list must contain the PydanticAI adapter and exclude tests, caches, secrets, and generated environments where appropriate.

### Real smoke tests

Two manual examples provide runtime evidence:

1. `offline_memory_demo.py` uses a local fake Gateway and an offline PydanticAI model, proving the complete lifecycle without a cloud key.
2. `deepseek_memory_demo.py` reads `DEEPSEEK_API_KEY` and a configurable model name. It performs at least two turns in one session: storing a preference and later asking the agent to recall it.

The real example is considered verified only after successful execution with the user's locally configured key. Its console output may be summarized in the PR, but secrets and private conversation content must not be committed.

## Documentation

`pydantic-ai-plugin/README.md` and `README_CN.md` will cover:

- architecture and lifecycle mapping;
- installation;
- Gateway startup and configuration;
- async and sync quick starts;
- DeepSeek and offline examples;
- automatic recall/capture behavior;
- search tools;
- identity and session-key rules;
- fail-open and strict modes;
- authentication, deployment, and secret handling;
- troubleshooting;
- limitations and extension best practices.

The root English and Chinese READMEs will add a concise PydanticAI entry and link to these documents.

## Non-Goals

- implementing another new agent platform;
- replacing the Gateway with a Python port of `TdaiCore`;
- building a universal adapter SDK;
- changing memory ranking, extraction, storage, or schema behavior;
- automatically capturing failed or partial model runs;
- automatic capture retries without an idempotency contract;
- full multimodal prompt serialization;
- hiding application-level authorization behind `user_id`.

## Completion Evidence

The contribution is complete only when all of the following are true:

1. the adapter package and public API exist as documented;
2. automatic recall, successful-turn capture, explicit searches, and session end are covered by tests;
3. fail-open, strict, security, timeout, and retry behavior are covered by tests;
4. async and sync examples are documented;
5. offline tests and repository build/package checks pass;
6. the DeepSeek example runs successfully using a locally supplied key;
7. the branch is pushed to the contributor's fork;
8. a PR referencing #235 is opened against `TencentCloud/TencentDB-Agent-Memory`;
9. the PR diff, generated package contents, and initial CI state are inspected.
