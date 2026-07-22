# TencentDB Agent Memory for LlamaIndex

This adapter implements LlamaIndex 0.14's native `BaseMemoryBlock[str]`
contract. It recalls long-term context when LlamaIndex assembles model input and
captures messages when the framework waterfalls them out of short-term memory.

## Architecture

```mermaid
flowchart LR
  Agent[LlamaIndex Agent / Workflow] --> Memory[LlamaIndex Memory]
  Memory -->|aget / aput| Block[TencentDBMemoryBlock]
  Block -->|/recall + /search/memories| Gateway[TDAI Gateway]
  Block -->|/capture + /session/end| Gateway
  Gateway --> Core[TdaiCore L0 → L1 → L2 → L3]
```

## Install and use

Start the Gateway, then install the shared client and adapter:

```bash
pip install -e ./python-gateway-sdk -e ./llamaindex-plugin
```

```python
import asyncio

from llama_index.core.memory import Memory
from memory_tencentdb_llamaindex import TencentDBMemoryBlock

block = TencentDBMemoryBlock(
    user_id="alice",
    gateway_url="http://127.0.0.1:8420",
)
memory = Memory.from_defaults(
    session_id="research-team:alice",
    memory_blocks=[block],
)

# Pass `memory` to a LlamaIndex agent or workflow.
# On shutdown, explicitly flush the remote session.
asyncio.run(block.aclose("research-team:alice"))
```

By default the Gateway key is `llamaindex:<Memory.session_id>`. Set an explicit
`session_key` when several LlamaIndex sessions should share long-term context.
`user_id` records provenance; it is not a tenant authorization boundary.

`strict=False` fails open on a sidecar outage. Set `strict=True` for controlled
jobs where memory availability is mandatory. `reset()` remains owned by
LlamaIndex's short-term store; this block intentionally exposes no remote
delete operation.

## Lifecycle mapping

| LlamaIndex operation | Gateway route | Behavior |
| --- | --- | --- |
| `BaseMemoryBlock.aget()` | `/recall` + `/search/memories` | Injects formatted long-term context |
| `BaseMemoryBlock.aput()` | `/capture` | Captures a waterfall batch once |
| `TencentDBMemoryBlock.aclose()` | `/session/end` | Flushes the remote session pipeline |

## Test

```bash
python -m unittest discover -s llamaindex-plugin/tests -t llamaindex-plugin -v
```

Tests use the real LlamaIndex models and a fake in-process Gateway client; no
LLM credentials or external service is required.
