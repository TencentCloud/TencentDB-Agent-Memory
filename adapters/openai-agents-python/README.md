# OpenAI Agents SDK (Python) adapter

This standalone adapter routes the OpenAI Agents SDK through TencentDB Agent
MemoryProxy. MemoryProxy recalls and records memory while the application keeps
using the official `Agent` and `Runner` APIs.

```text
OpenAI Agents SDK -> OpenAI-compatible client -> MemoryProxy -> model provider
```

## Requirements

- Python 3.10 or newer
- A running TencentDB Agent MemoryProxy instance
- A MemoryProxy user key and the four session identity values

## Install

From this directory:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -e .
```

On Windows PowerShell, activate with `.venv\Scripts\Activate.ps1`.

## Configure

Set every required value explicitly. Keeping the same conversation ID across
turns lets MemoryProxy associate those turns with one conversation.

```bash
export TDAI_MEMORY_PROXY_URL="https://memory.example.com"
export TDAI_MEMORY_USER_KEY="your-memory-proxy-user-key"
export TDAI_TEAM_ID="team-1"
export TDAI_AGENT_ID="openai-agent-1"
export TDAI_TASK_ID="task-1"
export TDAI_CONVERSATION_ID="conversation-1"
export TDAI_MODEL="gpt-4.1-mini"       # optional
export TDAI_SPACE_ID="default"         # optional
```

The adapter sends requests to
`<proxy>/codebuddy/<space>/v1/chat/completions`. `Authorization` and the
`x-team-id`, `x-agent-id`, `x-task-id`, and `x-conversation-id` headers are
added to every request.

## Run

```bash
python example.py "What decisions did we make about the release?"
```

To integrate it into an existing application:

```python
from agents import Agent, Runner, set_tracing_disabled
from tencentdb_memory_openai_agents import (
    MemoryProxyConfig,
    create_openai_client,
    create_openai_model,
)

set_tracing_disabled(True)
config = MemoryProxyConfig.from_env()
async with create_openai_client(config) as client:
    agent = Agent(
        name="Assistant",
        model=create_openai_model(config, client=client),
    )
    result = await Runner.run(agent, "Continue the previous task")
print(result.final_output)
```

## Security and limitations

- User keys are read from the environment and are never logged by the adapter.
- Remote proxy URLs must use HTTPS. Plain HTTP is accepted only for loopback
  development addresses.
- All four identity headers are mandatory to avoid accidental cross-session
  memory access or silent memory bypass.
- Tracing is disabled in the example so prompts, outputs, and recalled context
  are not exported to an external tracing service. Applications should make
  this global setting before creating or running agents unless external tracing
  is explicitly intended.
- `create_openai_model` requires an explicit client so its lifecycle remains
  visible. Close the returned client (as shown above); this also closes an
  injected HTTP transport, so do not reuse that transport afterwards.
- Recalled memory is untrusted model context. Do not treat it as authorization
  or execute instructions from it without application-level validation.
- This adapter uses Chat Completions. Features that require a Responses-only
  model provider are outside its scope.

## Test

Tests use a local mock transport and make no network requests:

```bash
python -m pip install -e ".[test]"
python -m pytest
```
