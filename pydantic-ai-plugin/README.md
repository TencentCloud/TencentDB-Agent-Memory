# TencentDB Agent Memory for PydanticAI

[简体中文](./README_CN.md)

An independent Python adapter that connects a
[PydanticAI](https://pydantic.dev/docs/ai/) `Agent` to the existing
TencentDB Agent Memory Gateway.

The adapter automatically recalls context before each non-streaming agent run,
captures the completed turn after a successful run, adds explicit memory search
tools, and exposes an explicit session-end operation. It supports both async and
sync applications.

## Architecture

```mermaid
flowchart LR
    App["PydanticAI application"] --> Wrapper["TencentDBMemoryAgent"]
    Wrapper -->|"recall / capture / search / session end"| Client["GatewayClient"]
    Client -->|"HTTP JSON + optional Bearer"| Gateway["Existing TdaiGateway"]
    Gateway --> Core["TdaiCore"]
    Core --> Memory["L0 → L1 → L2 → L3 memory"]
```

The Python package does not reimplement `TdaiCore` and does not modify the
OpenClaw or Hermes integrations.

| Platform | Boundary | Recall | Capture | Session end |
| --- | --- | --- | --- | --- |
| OpenClaw | TypeScript in-process adapter | host lifecycle hook | committed-turn hook | host session hook |
| Hermes | Python provider over Gateway HTTP | provider prefetch | turn sync | provider shutdown/session method |
| PydanticAI | Python agent wrapper over Gateway HTTP | before `Agent.run` | after a successful result | explicit wrapper method |

## Requirements

- Python 3.11 or newer
- `pydantic-ai-slim[openai]` 2.x
- a running TencentDB Agent Memory Gateway
- Node.js 22.16 or newer when running the Gateway from this repository

## Install

From the repository root:

```bash
python -m venv .venv
python -m pip install -e "pydantic-ai-plugin"
```

On Windows PowerShell:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "pydantic-ai-plugin"
```

## Start the Gateway

The adapter is a Gateway client; it does not start or supervise the Node.js
process. From the repository root:

```bash
npm install
node --import tsx/esm src/gateway/server.ts
```

Verify it from another terminal:

```bash
curl http://127.0.0.1:8420/health
```

The default address is `http://127.0.0.1:8420`. See the root README for memory
storage, embedding, extraction model, Docker, and production Gateway
configuration.

## Async quick start

```python
from pydantic_ai import Agent

from memory_tencentdb_pydantic_ai import (
    GatewayClient,
    TencentDBMemoryAgent,
)

agent = Agent(
    "deepseek:deepseek-chat",
    instructions="Answer concisely.",
)
memory_agent = TencentDBMemoryAgent(
    agent,
    GatewayClient(
        "http://127.0.0.1:8420",
        api_key=None,
    ),
)

result = await memory_agent.run(
    "Remember that I prefer sugar-free coffee.",
    user_id="user-001",
    session_id="coffee-demo",
)
print(result.output)

flushed = await memory_agent.end_session(
    user_id="user-001",
    session_id="coffee-demo",
)
```

`run()` returns the original PydanticAI `AgentRunResult`, so APIs such as
`result.output`, `result.all_messages()`, and `result.new_messages()` remain
available.

## Sync quick start

```python
result = memory_agent.run_sync(
    "What coffee preference did I mention?",
    user_id="user-001",
    session_id="coffee-demo",
)

memory_agent.end_session_sync(
    user_id="user-001",
    session_id="coffee-demo",
)
```

Do not call PydanticAI's sync API from a thread that already has a running
asyncio event loop. Use `await memory_agent.run(...)` in async applications.

## Lifecycle

For each `run()` or `run_sync()`:

1. validate `user_id` and `session_id`;
2. call `POST /recall`;
3. append non-empty recalled context as run-scoped PydanticAI instructions;
4. append a per-run memory search toolset;
5. call the wrapped PydanticAI agent;
6. after a successful result, call `POST /capture` exactly once;
7. return the original result.

If the model raises, the exception propagates and capture is not attempted.
Recalled context is not appended to persistent message history. Caller-supplied
runtime instructions, message history, dependencies, model settings, usage
limits, and toolsets are forwarded.

The first release supports text user prompts and non-streaming `run` /
`run_sync`. String and structured outputs are serialized safely for capture.

## Search tools

Every run receives two tools:

```text
memory_search(query, limit=5, memory_type=None, scene=None)
conversation_search(query, limit=5)
```

- `memory_search` searches structured long-term memories.
- `conversation_search` searches raw conversation evidence within the current
  session key.

Automatic recall still runs before the agent. The tools let the model perform
more focused searches when the initially recalled context is insufficient.

If an application toolset already defines either reserved name, PydanticAI
rejects the duplicate configuration instead of silently replacing a tool.

## Conversation history

PydanticAI message history and TencentDB memory have different purposes. Pass
PydanticAI history normally:

```python
first = await memory_agent.run(
    "Remember my preference.",
    user_id="user-001",
    session_id="demo",
)
second = await memory_agent.run(
    "What was it?",
    user_id="user-001",
    session_id="demo",
    message_history=first.all_messages(),
)
```

The same stable identity is used for Gateway recall and capture, while
`message_history` controls the immediate PydanticAI conversation.

## Identity and session keys

Both IDs must be non-empty. The default Gateway session key is:

```text
pydantic-ai:{percent-encoded-user-id}:{percent-encoded-session-id}
```

For example, `user:一` and `session/1` become:

```text
pydantic-ai:user%3A%E4%B8%80:session%2F1
```

To join an existing memory namespace, pass `session_key` explicitly to
`run`, `run_sync`, `end_session`, and `end_session_sync`.

`user_id` is memory provenance and `session_key` is a retrieval boundary.
Neither is an authentication or tenant-authorization mechanism. Authorize the
caller in your application before invoking the adapter.

## Failure modes

The default is `strict=False`:

| Operation | Default behavior on Gateway error |
| --- | --- |
| Recall | log an operation-only warning and run without recalled context |
| Search tool | return a structured `memory service unavailable` result |
| Capture | log a warning and preserve the successful model result |
| Session end | log a warning and return `False` |

Use fail-fast behavior during development or when memory is mandatory:

```python
memory_agent = TencentDBMemoryAgent(
    agent,
    GatewayClient(),
    strict=True,
)
```

In strict mode, `GatewayConnectionError`, `GatewayHTTPError`, and
`GatewayResponseError` propagate.

### Timeout and retry policy

```python
client = GatewayClient(
    "http://127.0.0.1:8420",
    timeout=10,
    retries=1,
    retry_delay=0.1,
)
```

- transient connection failures and HTTP 5xx responses may be retried for
  health, recall, search, and session end;
- authentication and other HTTP 4xx responses are not retried;
- capture is **never retried automatically**, because the current Gateway
  contract has no idempotency key and a retry could duplicate memory;
- every request has a finite timeout.

## Gateway authentication and deployment

Local development can use the default loopback-only Gateway without a token.
To enable Gateway Bearer authentication:

```bash
export TDAI_GATEWAY_API_KEY="set-a-local-secret"
node --import tsx/esm src/gateway/server.ts
```

Configure the same value on the client:

```python
client = GatewayClient(
    "http://127.0.0.1:8420",
    api_key=os.environ["TDAI_GATEWAY_API_KEY"],
)
```

The token is sent only in `Authorization: Bearer ...`; it is omitted from
client representations, warnings, and adapter exceptions.

For a non-loopback deployment:

- require Gateway authentication;
- terminate TLS at the Gateway or a trusted reverse proxy;
- restrict network access;
- enforce application authorization independently of memory IDs;
- never commit `.env` files, API keys, or captured conversations.

The client rejects base URLs with embedded credentials, query strings, or
fragments.

## Examples

Credential-free lifecycle proof:

```bash
python pydantic-ai-plugin/examples/offline_memory_demo.py
```

Expected output includes:

```text
recall -> agent -> capture -> session_end
```

Real DeepSeek two-turn demo:

```bash
export DEEPSEEK_API_KEY="set-locally"
export TDAI_GATEWAY_URL="http://127.0.0.1:8420"
python pydantic-ai-plugin/examples/deepseek_memory_demo.py
```

Optional variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PYDANTIC_AI_MODEL` | `deepseek:deepseek-chat` | PydanticAI model alias |
| `TDAI_GATEWAY_URL` | `http://127.0.0.1:8420` | Gateway base URL |
| `TDAI_GATEWAY_API_KEY` | unset | optional Gateway Bearer token |

The DeepSeek key is read by PydanticAI from the environment and is never sent
to the TencentDB Agent Memory Gateway.

## Tests

From the repository root:

```bash
python -m unittest discover -s pydantic-ai-plugin/tests -v
python -m build pydantic-ai-plugin
```

The test suite uses local HTTP servers and PydanticAI `TestModel` /
`FunctionModel`. It requires no model API key and blocks accidental real model
requests.

## Troubleshooting

### `Connection refused`

Start the Gateway and verify `GET /health`. Confirm `TDAI_GATEWAY_URL` and the
port.

### HTTP 401

The Gateway and client token must match. `GET /health` can succeed even when
authenticated POST routes reject the client.

### The agent answers, but no memory is recalled

Fail-open mode intentionally allows this. Check warning logs, Gateway storage
and extraction-model configuration, and use `strict=True` while diagnosing.
Capture transport success does not by itself prove that higher-level memory
extraction has completed.

### DeepSeek key error

Set `DEEPSEEK_API_KEY` in the current process. Do not paste it into the example
source.

### Editable install fails in a non-ASCII Windows path

Some Python 3.11/Hatchling combinations write an editable `.pth` path in UTF-8
while the interpreter reads it using a legacy Windows code page. Use an ASCII
checkout path for the development virtual environment, or build and install the
wheel instead:

```powershell
py -3.11 -m build pydantic-ai-plugin
py -3.11 -m pip install pydantic-ai-plugin\dist\*.whl
```

## Acceptance scope

This contribution implements one new platform and targets the intermediate
acceptance stage of issue #235. The comparison above documents three lifecycle
patterns, but it does not claim two new adapters or a universal adapter SDK.
