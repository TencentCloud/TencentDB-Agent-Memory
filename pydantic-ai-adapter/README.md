# TencentDB Agent Memory for PydanticAI

A PydanticAI 2.x capability backed by the existing TDAI HTTP Gateway.

## Install

From the repository root:

```bash
pip install -e ./pydantic-ai-adapter
```

For adapter development:

```bash
pip install -e "./pydantic-ai-adapter[test]"
```

## Use

```python
import os
from dataclasses import dataclass

from pydantic_ai import Agent
from tdai_pydantic_ai import TencentDBMemoryCapability


@dataclass
class Deps:
    session_key: str
    user_id: str


memory = TencentDBMemoryCapability(
    session_key=lambda ctx: ctx.deps.session_key,
    user_id=lambda ctx: ctx.deps.user_id,
    base_url=os.getenv("TDAI_GATEWAY_URL", "http://127.0.0.1:8420"),
    api_key=os.getenv("TDAI_GATEWAY_API_KEY"),
)

agent = Agent(
    "openai:gpt-5.2",
    deps_type=Deps,
    capabilities=[memory],
)

result = await agent.run(
    "Which editor do I prefer?",
    deps=Deps(session_key="chat-42", user_id="alice"),
)
await memory.end_session("chat-42", "alice")
```

`base_url` may point to a local or remote Gateway. Set `api_key` to the same
Bearer token configured by the Gateway, or leave it unset when Gateway
authentication is disabled.

See the [complete PydanticAI adapter guide](../docs/adapters/pydantic-ai.md)
for lifecycle, search tools, failure behavior, and troubleshooting. See also
the [main project README](../README.md).

## Test

From this directory:

```bash
python -m pytest tests -q
```
