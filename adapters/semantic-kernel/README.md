# TencentDB Agent Memory — Semantic Kernel Adapter

Give [Semantic Kernel](https://github.com/microsoft/semantic-kernel) (Python) agents persistent memory backed by TencentDB Agent Memory: every turn is captured into the L0 → L3 memory pipeline, and relevant memories are recalled or searchable on demand.

Once wired in, your SK agent gets:

- **Turn capture** — incremental user/assistant transcript streamed to the gateway (`POST /capture`)
- **Automatic recall** — recalled memory context injected into every agent turn via a native `PROMPT_RENDERING` filter (`POST /recall`), with two configurable injection modes
- **Retrieval tools** — a `KernelPlugin` exposing `memory_search` (long-term) and `conversation_search` (session-scoped) as kernel functions the model can call
- **Session flush** — explicit `POST /session/end` at thread shutdown

> Note: this targets Semantic Kernel itself. Microsoft Agent Framework (SK's successor) has a separate open integration (see PR #568 in this repository).

## How it works

```
Semantic Kernel ChatCompletionAgent
  ├─ PROMPT_RENDERING filter ─(POST /recall)──► memory context injected
  ├─ TencentDBMemory plugin ──(POST /search/*)─► model-driven retrieval
  └─ capture_thread(thread) ──(POST /capture)──► L0 → L3 pipeline
                                               ▼
                       Memory Core Gateway (port 8420)
                        (capture · extract · store · recall)
```

The adapter talks to the **memory-core gateway** (`:8420` by default), which runs the memory engine (extraction, dedup, scenario distillation, profiling).

## Prerequisites

1. TencentDB Agent Memory running locally:

   ```bash
   cd TencentDB-Agent-Memory/deploy/global-images
   cp .env.example .env && $EDITOR .env
   ./start-all.sh
   ```

   Set `MEMORY_LLM_BASE_URL` / `MEMORY_LLM_API_KEY` / `MEMORY_LLM_MODEL` in `.env` — the memory engine uses this LLM for extraction and recall.

2. Python 3.10+ with Semantic Kernel:

   ```bash
   pip install semantic-kernel
   ```

3. An OpenAI-compatible API key for your agent's chat model.

## Installation

```bash
pip install ./adapters/semantic-kernel
```

Or copy the `tdai_sk/` package into your project (it has no local dependencies beyond `semantic-kernel` and `httpx`).

## Quickstart

```python
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.open_ai import OpenAIChatCompletion
from semantic_kernel.kernel import Kernel

from tdai_sk import TDAiConfig, TencentDBAgentMemory

mem = TencentDBAgentMemory(TDAiConfig(
    app_name="my-app",
    user_id="user-42",
    gateway_url="http://127.0.0.1:8420",
    api_key=os.environ.get("TDAI_GATEWAY_API_KEY", ""),
))

kernel = Kernel()
kernel.add_service(OpenAIChatCompletion(ai_model_id="gpt-4o-mini"))
mem.attach(kernel)                     # automatic recall filter

agent = ChatCompletionAgent(
    kernel=kernel,
    name="assistant",
    instructions="You are a concise assistant.",
    plugins=[mem.as_plugin()],         # memory_search / conversation_search
)

response = await agent.get_response(messages="Remember: my codename is Apollo Lake.")
await mem.capture_thread(response.thread)   # incremental capture
# ... later, in a brand-new thread ...
response = await agent.get_response(messages="What is my codename?")
await mem.capture_thread(response.thread)
await mem.end_session(response.thread)
await mem.close()
```

## Recall injection modes

`TDAiConfig.recall_mode` controls how recalled context reaches the prompt:

| Mode | Behavior |
|---|---|
| `"append"` *(default)* | Recalled block is appended to the rendered instructions each turn. Zero configuration. |
| `"template"` | Recalled block is written to the `{{TDaiMemory}}` template variable — place it explicitly in your instructions: `Relevant memory:\n{{TDaiMemory}}`. |
| `"off"` | Automatic recall disabled (tools still work). |

## Configuration reference

| Field | Effect | Default |
|---|---|---|
| `gateway_url` | memory-core gateway URL (remote plaintext HTTP rejected unless `allow_remote_http=True`) | `http://127.0.0.1:8420` |
| `api_key` | `Authorization: Bearer` key; required when gateway starts with `TDAI_GATEWAY_API_KEY` | `""` |
| `app_name` / `user_id` | Identity scope for capture/recall | `"semantic-kernel-app"` / `"default-user"` |
| `timeout` | Per-request HTTP timeout | `5.0` s |
| `recall_mode` | `append` / `template` / `off` | `append` |
| `max_context_chars` | Hard bound on the injected recall block | `4000` |
| `allow_remote_http` | Permit plaintext HTTP to a non-local gateway | `False` |
| `memory_search_tool` | expose `memory_search` kernel function | `True` |
| `conversation_search_tool` | expose `conversation_search` | `True` |
| `fail_open` | memory errors logged-and-swallowed instead of raised | `True` |

## Security and behavior

- **Identity scoping**: `app_name` / `user_id` are sent on every gateway request; they are provenance metadata, not an authorization boundary — hard multi-tenant isolation depends on the gateway.
- **No cleartext credentials to remote hosts**: `http://` is only allowed for loopback gateways by default; `https://` or explicit `allow_remote_http=True` is required otherwise.
- **Prompt-injection hardening**: recalled context is bounded by `max_context_chars`, wrapped in explicit delimiters marked as *untrusted context*, and nested occurrences of the block delimiters are sanitized so gateway content cannot forge the memory section.
- **Fail-open by default**: recall/capture/search failures are logged and skipped so the chat path never blocks; set `fail_open=False` when memory is a hard requirement.
- **Capture retries**: the per-thread watermark advances only after a successful response, so failed captures are retried. Narrow duplicate window: if the gateway persists a turn but the response is lost, the retry resends the same delta (message IDs are server-assigned).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `GatewayError` on health check | Stack not running — start it and check `MEMORY_CORE_PORT` (8420). |
| Gateway returns 401 | Gateway started with `TDAI_GATEWAY_API_KEY` — pass it via `TDAiConfig(api_key=...)`. |
| No memory recalled in new threads | Extraction is asynchronous — wait a few seconds and retry; verify `recall_mode != "off"`. |
| Model never calls the tools | Ensure `plugins=[mem.as_plugin()]` and function-calling is enabled (`FunctionChoiceBehavior.Auto()` is the agent default). |
| Template mode renders `{{TDaiMemory}}` empty | The variable is only set when recall returns context; also ensure `recall_mode="template"` and `mem.attach(kernel)` was called. |

## Testing

Smoke tests run against a fake gateway (no stack or LLM needed), split into six per-module files with 54 cases:

```bash
cd adapters/semantic-kernel
pip install -e ".[test]"
pytest
```

## Notes

- **Multi-tenant caution**: recall and `memory_search` read the gateway's shared long-term store; the gateway does not enforce per-user isolation on those paths. For shared deployments keep `recall_mode="off"` and disable `memory_search_tool`, or front the gateway with tenant isolation.
- **Version**: verified with `semantic-kernel>=1.30` and TencentDB Agent Memory v2 images (`feat/server_team` branch).

## License

MIT, same as the main repository.
