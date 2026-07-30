# PydanticAI Memory Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested PydanticAI adapter that automatically recalls TencentDB Agent Memory context, captures successful turns, exposes search tools, and supports explicit session end through the existing Gateway.

**Architecture:** Create an independent Python package under `pydantic-ai-plugin/`. `TencentDBMemoryAgent` wraps an existing PydanticAI `Agent`; a standard-library `GatewayClient` owns the HTTP boundary, while focused identity, serialization, and toolset modules keep lifecycle logic independently testable. The existing TypeScript core and Gateway contracts remain unchanged.

**Tech Stack:** Python 3.11+, `pydantic-ai-slim[openai]` 2.x, standard-library `urllib`, `unittest`, PydanticAI `TestModel`/`FunctionModel`, Node.js 22+, npm, TypeScript/Vitest.

**Authoritative references:**

- Design: `docs/superpowers/specs/2026-07-30-pydantic-ai-memory-adapter-design.md`
- Gateway contract: `src/gateway/types.ts`
- Existing Python HTTP style: `hermes-plugin/memory/memory_tencentdb/client.py`
- PydanticAI run arguments: `Agent.run(..., instructions=..., toolsets=...)`
- PydanticAI tools: `FunctionToolset`
- PydanticAI offline tests: `TestModel(custom_output_text=...)` and `FunctionModel`
- DeepSeek provider: `Agent("deepseek:deepseek-chat")` with `DEEPSEEK_API_KEY`

---

## File Map

### New package files

- `pydantic-ai-plugin/pyproject.toml`: package metadata, Python compatibility, runtime and build dependencies.
- `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/__init__.py`: stable public exports.
- `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/errors.py`: adapter-specific Gateway exceptions.
- `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/identity.py`: validated user/session identity and deterministic session key.
- `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/serialization.py`: stable text/structured output serialization.
- `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/client.py`: authenticated Gateway HTTP client with strict response checks and safe retry policy.
- `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/tools.py`: per-run `FunctionToolset` for memory and conversation search.
- `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/agent.py`: async/sync PydanticAI lifecycle wrapper.
- `pydantic-ai-plugin/tests/fake_gateway.py`: controllable local HTTP server and request recorder.
- `pydantic-ai-plugin/tests/test_identity.py`: identity and session key tests.
- `pydantic-ai-plugin/tests/test_serialization.py`: structured output serialization tests.
- `pydantic-ai-plugin/tests/test_client.py`: Gateway transport, auth, error, timeout, and retry tests.
- `pydantic-ai-plugin/tests/test_tools.py`: tool result and fail-open/strict tests.
- `pydantic-ai-plugin/tests/test_agent.py`: real PydanticAI lifecycle tests using offline models.
- `pydantic-ai-plugin/examples/offline_memory_demo.py`: credential-free lifecycle demonstration.
- `pydantic-ai-plugin/examples/deepseek_memory_demo.py`: real DeepSeek two-turn demonstration.
- `pydantic-ai-plugin/README.md`: English integration guide.
- `pydantic-ai-plugin/README_CN.md`: Chinese integration guide.

### Existing files to modify

- `.gitignore`: ignore Python virtual environments and build artifacts.
- `package.json`: include `pydantic-ai-plugin/` in npm package contents while excluding tests/build output.
- `README.md`: add PydanticAI integration entry.
- `README_CN.md`: add Chinese PydanticAI integration entry.

---

### Task 1: Package Metadata, Identity, and Serialization

**Files:**

- Create: `pydantic-ai-plugin/pyproject.toml`
- Create: `pydantic-ai-plugin/README.md`
- Create: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/__init__.py`
- Create: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/identity.py`
- Create: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/serialization.py`
- Create: `pydantic-ai-plugin/tests/__init__.py`
- Create: `pydantic-ai-plugin/tests/test_identity.py`
- Create: `pydantic-ai-plugin/tests/test_serialization.py`
- Modify: `.gitignore`

- [ ] **Step 1: Add failing identity and serialization tests**

Create `test_identity.py` with cases that require non-empty IDs, percent-encode separators, and preserve explicit overrides:

```python
import unittest

from memory_tencentdb_pydantic_ai.identity import MemoryIdentity


class MemoryIdentityTests(unittest.TestCase):
    def test_default_session_key_is_deterministic_and_escaped(self) -> None:
        identity = MemoryIdentity.create("user:一", "session/1")
        self.assertEqual(
            identity.session_key,
            "pydantic-ai:user%3A%E4%B8%80:session%2F1",
        )

    def test_explicit_session_key_is_preserved(self) -> None:
        identity = MemoryIdentity.create("u", "s", session_key="legacy:key")
        self.assertEqual(identity.session_key, "legacy:key")

    def test_empty_values_are_rejected(self) -> None:
        for user_id, session_id in (("", "s"), ("u", ""), (" ", "s")):
            with self.subTest(user_id=user_id, session_id=session_id):
                with self.assertRaises(ValueError):
                    MemoryIdentity.create(user_id, session_id)
```

Create `test_serialization.py` with a Pydantic model and deterministic JSON assertions:

```python
import unittest

from pydantic import BaseModel

from memory_tencentdb_pydantic_ai.serialization import serialize_output


class Profile(BaseModel):
    language: str
    score: int


class SerializeOutputTests(unittest.TestCase):
    def test_string_is_not_json_quoted(self) -> None:
        self.assertEqual(serialize_output("你好"), "你好")

    def test_pydantic_model_is_stable_json(self) -> None:
        output = serialize_output(Profile(language="zh", score=9))
        self.assertEqual(output, '{"language":"zh","score":9}')

    def test_mapping_keys_are_sorted(self) -> None:
        self.assertEqual(serialize_output({"z": 1, "a": "中"}), '{"a":"中","z":1}')
```

- [ ] **Step 2: Run the tests and verify imports fail**

Run:

```powershell
py -3.11 -m unittest discover -s pydantic-ai-plugin/tests -p "test_identity.py" -v
py -3.11 -m unittest discover -s pydantic-ai-plugin/tests -p "test_serialization.py" -v
```

Expected: both commands fail because `memory_tencentdb_pydantic_ai` does not exist.

- [ ] **Step 3: Add package metadata**

Create `pyproject.toml`:

```toml
[build-system]
requires = ["hatchling>=1.27,<2"]
build-backend = "hatchling.build"

[project]
name = "memory-tencentdb-pydantic-ai"
version = "0.1.0"
description = "PydanticAI adapter for TencentDB Agent Memory Gateway"
readme = "README.md"
requires-python = ">=3.11"
license = { text = "MIT" }
dependencies = [
  "pydantic-ai-slim[openai]>=2.0,<3",
]

[project.optional-dependencies]
dev = ["build>=1.2,<2"]

[tool.hatch.build.targets.wheel]
packages = ["src/memory_tencentdb_pydantic_ai"]
```

Append to `.gitignore`:

```gitignore
# Python environments and package output
.venv/
venv/
pydantic-ai-plugin/build/
pydantic-ai-plugin/dist/
pydantic-ai-plugin/*.egg-info/
```

- Create `pydantic-ai-plugin/README.md` with the minimal valid package description `# TencentDB Agent Memory for PydanticAI`. Task 7 expands this file into the complete English guide.

- [ ] **Step 4: Implement identity and serialization**

Create `identity.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote


@dataclass(frozen=True, slots=True)
class MemoryIdentity:
    user_id: str
    session_id: str
    session_key: str

    @classmethod
    def create(
        cls,
        user_id: str,
        session_id: str,
        *,
        session_key: str | None = None,
    ) -> "MemoryIdentity":
        clean_user = user_id.strip()
        clean_session = session_id.strip()
        if not clean_user:
            raise ValueError("user_id must not be empty")
        if not clean_session:
            raise ValueError("session_id must not be empty")
        if session_key is not None:
            clean_key = session_key.strip()
            if not clean_key:
                raise ValueError("session_key must not be empty")
        else:
            clean_key = (
                f"pydantic-ai:{quote(clean_user, safe='')}:"
                f"{quote(clean_session, safe='')}"
            )
        return cls(clean_user, clean_session, clean_key)
```

Create `serialization.py`:

```python
from __future__ import annotations

import dataclasses
import json
from typing import Any

from pydantic import BaseModel


def serialize_output(output: Any) -> str:
    if isinstance(output, str):
        return output
    if isinstance(output, BaseModel):
        value = output.model_dump(mode="json")
    elif dataclasses.is_dataclass(output) and not isinstance(output, type):
        value = dataclasses.asdict(output)
    else:
        value = output
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
```

Create `__init__.py` initially with:

```python
from .identity import MemoryIdentity
from .serialization import serialize_output

__all__ = ["MemoryIdentity", "serialize_output"]
```

- [ ] **Step 5: Create an editable environment and run the tests**

Run:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e "pydantic-ai-plugin[dev]"
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_identity.py" -v
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_serialization.py" -v
```

Expected: six tests pass.

- [ ] **Step 6: Commit**

```powershell
git add .gitignore pydantic-ai-plugin/pyproject.toml pydantic-ai-plugin/src pydantic-ai-plugin/tests
git commit -m "feat(pydantic-ai): add package foundations"
```

---

### Task 2: Typed Gateway Client and Fake Server

**Files:**

- Create: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/errors.py`
- Create: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/client.py`
- Create: `pydantic-ai-plugin/tests/fake_gateway.py`
- Create: `pydantic-ai-plugin/tests/test_client.py`
- Modify: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/__init__.py`

- [ ] **Step 1: Add failing transport and contract tests**

Create a `FakeGateway` context manager backed by `ThreadingHTTPServer`. It must record method, path, headers, and decoded JSON body, and allow each test to enqueue `(status, body, delay)` responses.

Core tests in `test_client.py`:

```python
class GatewayClientTests(unittest.TestCase):
    def test_recall_sends_identity_and_bearer_token(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(200, {"context": "prefers tea", "memory_count": 1})
            client = GatewayClient(gateway.url, api_key=" secret ")
            result = client.recall("drink?", "pydantic-ai:u:s", "u")
        self.assertEqual(result["context"], "prefers tea")
        self.assertEqual(gateway.requests[0].path, "/recall")
        self.assertEqual(
            gateway.requests[0].headers["Authorization"], "Bearer secret"
        )
        self.assertEqual(
            gateway.requests[0].json,
            {"query": "drink?", "session_key": "pydantic-ai:u:s", "user_id": "u"},
        )

    def test_capture_is_never_retried(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(503, {"error": "temporary"})
            client = GatewayClient(gateway.url, retries=3, retry_delay=0)
            with self.assertRaises(GatewayHTTPError):
                client.capture("q", "a", "key", "sid", "uid")
        self.assertEqual(len(gateway.requests), 1)

    def test_safe_search_retries_transient_server_error(self) -> None:
        with FakeGateway() as gateway:
            gateway.enqueue(503, {"error": "temporary"})
            gateway.enqueue(200, {"results": "found", "total": 1, "strategy": "fts"})
            client = GatewayClient(gateway.url, retries=1, retry_delay=0)
            result = client.search_memories("query")
        self.assertEqual(result["total"], 1)
        self.assertEqual(len(gateway.requests), 2)
```

Also test all routes, Unicode JSON, invalid JSON, non-object JSON, 401 without retry, timeout, async counterparts, URL validation, and secret redaction.

- [ ] **Step 2: Run the client tests and verify failure**

Run:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_client.py" -v
```

Expected: import failure for `GatewayClient` and Gateway exceptions.

- [ ] **Step 3: Implement stable exceptions**

Create `errors.py`:

```python
class GatewayError(RuntimeError):
    """Base error for TencentDB Agent Memory Gateway operations."""


class GatewayConnectionError(GatewayError):
    def __init__(self, operation: str, message: str) -> None:
        self.operation = operation
        super().__init__(f"Gateway {operation} failed: {message}")


class GatewayHTTPError(GatewayError):
    def __init__(self, operation: str, status_code: int, body: str) -> None:
        self.operation = operation
        self.status_code = status_code
        self.body = body[:500]
        super().__init__(
            f"Gateway {operation} returned HTTP {status_code}: {self.body}"
        )


class GatewayResponseError(GatewayError):
    def __init__(self, operation: str, message: str) -> None:
        self.operation = operation
        super().__init__(f"Gateway {operation} response is invalid: {message}")
```

- [ ] **Step 4: Implement the HTTP request engine**

In `client.py`, define `GatewayClient` with:

```python
class GatewayClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        *,
        api_key: str | None = None,
        timeout: float = 10.0,
        retries: int = 1,
        retry_delay: float = 0.1,
    ) -> None:
        self._base_url = _validate_base_url(base_url)
        self._api_key = (api_key or "").strip() or None
        self._timeout = timeout
        self._retries = retries
        self._retry_delay = retry_delay

    def __repr__(self) -> str:
        return (
            f"GatewayClient(base_url={self._base_url!r}, "
            f"authenticated={self._api_key is not None})"
        )
```

Implement `_request(method, path, body, operation, safe_to_retry)` using `urllib.request`. Required rules:

```python
attempts = self._retries + 1 if safe_to_retry else 1
for attempt in range(attempts):
    try:
        # urlopen, UTF-8 decode, json.loads, require dict
        return payload
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode("utf-8", errors="replace")
        error = GatewayHTTPError(operation, exc.code, body_text)
        retryable = safe_to_retry and exc.code >= 500
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        error = GatewayConnectionError(operation, str(exc.reason if hasattr(exc, "reason") else exc))
        retryable = safe_to_retry
    if not retryable or attempt == attempts - 1:
        raise error
    time.sleep(self._retry_delay * (2**attempt))
```

Reject invalid JSON or JSON arrays with `GatewayResponseError`. Do not include `api_key`, request content, or authorization headers in any error text.

- [ ] **Step 5: Implement endpoint methods and async counterparts**

Add exact synchronous methods:

```python
health()
recall(query, session_key, user_id)
capture(user_content, assistant_content, session_key, session_id, user_id)
search_memories(query, limit=5, memory_type=None, scene=None)
search_conversations(query, limit=5, session_key=None)
end_session(session_key, user_id)
```

Validate required response fields and types against `src/gateway/types.ts`. Use `safe_to_retry=False` only for `capture`; health, recall, searches, and session end use safe retries.

Add async counterparts named `ahealth`, `arecall`, `acapture`, `asearch_memories`, `asearch_conversations`, and `aend_session`, each implemented as:

```python
async def arecall(self, query: str, session_key: str, user_id: str) -> dict[str, Any]:
    return await asyncio.to_thread(self.recall, query, session_key, user_id)
```

- [ ] **Step 6: Export the client and errors and run tests**

Update `__init__.py` to export:

```python
GatewayClient
GatewayError
GatewayConnectionError
GatewayHTTPError
GatewayResponseError
```

Run:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_client.py" -v
```

Expected: all client tests pass, including one-request capture and two-request safe retry assertions.

- [ ] **Step 7: Commit**

```powershell
git add pydantic-ai-plugin/src pydantic-ai-plugin/tests
git commit -m "feat(pydantic-ai): add Gateway client"
```

---

### Task 3: Per-Run PydanticAI Search Tools

**Files:**

- Create: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/tools.py`
- Create: `pydantic-ai-plugin/tests/test_tools.py`

- [ ] **Step 1: Add failing toolset tests**

Use a recording client double with async search methods. Test the actual PydanticAI tool schemas via `TestModel`:

```python
class MemoryToolsTests(unittest.IsolatedAsyncioTestCase):
    async def test_toolset_registers_stable_names(self) -> None:
        model = TestModel(custom_output_text="ok")
        agent = Agent(model)
        toolset = create_memory_toolset(
            RecordingClient(),
            MemoryIdentity.create("u", "s"),
            strict=False,
        )
        await agent.run("hello", toolsets=[toolset])
        names = [
            tool.name
            for tool in model.last_model_request_parameters.function_tools
        ]
        self.assertEqual(names, ["memory_search", "conversation_search"])

    async def test_memory_search_uses_current_identity(self) -> None:
        client = RecordingClient()
        toolset = create_memory_toolset(
            client, MemoryIdentity.create("u", "s"), strict=False
        )
        model = TestModel(call_tools=["memory_search"])
        agent = Agent(model)
        await agent.run("Find my coffee preference", toolsets=[toolset])
        self.assertEqual(len(client.memory_calls), 1)
```

Use `FunctionModel` for the separate exact-arguments test: its first response must return `ToolCallPart("memory_search", {"query": "coffee", "limit": 3, "memory_type": "preference"})`, and its second response must assert that the tool return contains `total == 1` before returning a final `TextPart`. This exercises the public Agent/toolset path and does not call internal `FunctionToolset` methods.

- [ ] **Step 2: Run the test and verify failure**

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_tools.py" -v
```

Expected: import failure for `create_memory_toolset`.

- [ ] **Step 3: Implement the toolset**

Create `tools.py`:

```python
from __future__ import annotations

import logging
from typing import Any

from pydantic_ai import FunctionToolset

from .client import GatewayClient
from .errors import GatewayError
from .identity import MemoryIdentity

logger = logging.getLogger(__name__)


def create_memory_toolset(
    client: GatewayClient,
    identity: MemoryIdentity,
    *,
    strict: bool,
) -> FunctionToolset[Any]:
    toolset: FunctionToolset[Any] = FunctionToolset(
        instructions=(
            "Use memory_search for relevant long-term facts and preferences. "
            "Use conversation_search for evidence from earlier turns."
        )
    )

    @toolset.tool_plain
    async def memory_search(
        query: str,
        limit: int = 5,
        memory_type: str | None = None,
        scene: str | None = None,
    ) -> dict[str, Any]:
        """Search relevant long-term memory for the current user."""
        try:
            return await client.asearch_memories(
                query, limit, memory_type, scene
            )
        except GatewayError as exc:
            if strict:
                raise
            logger.warning("TencentDB memory_search unavailable: %s", exc)
            return {"available": False, "error": "memory service unavailable", "results": ""}

    @toolset.tool_plain
    async def conversation_search(
        query: str,
        limit: int = 5,
    ) -> dict[str, Any]:
        """Search earlier conversation evidence in the current session."""
        try:
            return await client.asearch_conversations(
                query, limit, identity.session_key
            )
        except GatewayError as exc:
            if strict:
                raise
            logger.warning("TencentDB conversation_search unavailable: %s", exc)
            return {"available": False, "error": "memory service unavailable", "results": ""}

    return toolset
```

- [ ] **Step 4: Run tests and commit**

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_tools.py" -v
git add pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/tools.py pydantic-ai-plugin/tests/test_tools.py
git commit -m "feat(pydantic-ai): add memory search tools"
```

Expected: tool tests pass and registered tool names are stable.

---

### Task 4: Automatic Async Recall and Capture

**Files:**

- Create: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/agent.py`
- Create: `pydantic-ai-plugin/tests/test_agent.py`
- Modify: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/__init__.py`

- [ ] **Step 1: Add failing async lifecycle tests**

Use `Agent(TestModel(custom_output_text="remembered"))` and a recording client. Cover:

```python
class TencentDBMemoryAgentAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_recalls_then_captures_once(self) -> None:
        client = RecordingClient(context="The user prefers sugar-free coffee.")
        model = TestModel(custom_output_text="I will remember that.")
        wrapped = TencentDBMemoryAgent(Agent(model), client)

        result = await wrapped.run(
            "Remember my preference",
            user_id="u",
            session_id="s",
            instructions="Answer concisely.",
        )

        self.assertEqual(result.output, "I will remember that.")
        self.assertEqual(client.events, ["recall", "capture"])
        self.assertEqual(client.captures[0]["assistant_content"], result.output)
        instructions = result.all_messages()[0].instructions
        self.assertIn("Answer concisely.", instructions)
        self.assertIn("The user prefers sugar-free coffee.", instructions)

    async def test_model_error_is_not_captured(self) -> None:
        client = RecordingClient(context="")
        wrapped = TencentDBMemoryAgent(FailingAgent(), client)
        with self.assertRaisesRegex(RuntimeError, "model failed"):
            await wrapped.run("hello", user_id="u", session_id="s")
        self.assertEqual(client.capture_calls, 0)
```

Add tests for:

- empty recall context adds no memory instruction;
- caller toolsets are preserved and memory toolset is appended;
- caller message history is forwarded unchanged;
- structured Pydantic output is serialized deterministically;
- fail-open recall continues without context;
- fail-open capture returns the original model result;
- strict recall/capture raises the original `GatewayError`;
- non-text user input is rejected before recall.

- [ ] **Step 2: Run tests and verify failure**

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_agent.py" -v
```

Expected: import failure for `TencentDBMemoryAgent`.

- [ ] **Step 3: Implement instruction and toolset merging helpers**

In `agent.py`:

```python
MEMORY_INSTRUCTION_PREFIX = (
    "TencentDB Agent Memory recalled the following context. "
    "Use it only when relevant and do not claim it is newer than the current user message:\n"
)


def _merge_instructions(existing: Any, context: str) -> Any:
    if not context.strip():
        return existing
    memory_instruction = MEMORY_INSTRUCTION_PREFIX + context.strip()
    if existing is None:
        return memory_instruction
    if isinstance(existing, (list, tuple)):
        return [*existing, memory_instruction]
    return [existing, memory_instruction]


def _merge_toolsets(existing: Any, memory_toolset: Any) -> list[Any]:
    return [*(existing or ()), memory_toolset]
```

PydanticAI itself detects duplicate tool names across the combined toolsets and raises its explicit configuration error; do not silently overwrite caller tools.

- [ ] **Step 4: Implement async lifecycle**

Implement:

```python
class TencentDBMemoryAgent:
    def __init__(
        self,
        agent: Agent[Any, Any],
        client: GatewayClient,
        *,
        strict: bool = False,
    ) -> None:
        self._agent = agent
        self._client = client
        self._strict = strict

    @property
    def agent(self) -> Agent[Any, Any]:
        return self._agent

    async def run(
        self,
        user_prompt: str,
        *,
        user_id: str,
        session_id: str,
        session_key: str | None = None,
        **run_kwargs: Any,
    ) -> AgentRunResult[Any]:
        if not isinstance(user_prompt, str):
            raise TypeError("TencentDBMemoryAgent currently supports text prompts only")
        identity = MemoryIdentity.create(
            user_id, session_id, session_key=session_key
        )
        context = await self._recall_async(user_prompt, identity)
        memory_toolset = create_memory_toolset(
            self._client, identity, strict=self._strict
        )
        run_kwargs["instructions"] = _merge_instructions(
            run_kwargs.get("instructions"), context
        )
        run_kwargs["toolsets"] = _merge_toolsets(
            run_kwargs.get("toolsets"), memory_toolset
        )
        result = await self._agent.run(user_prompt, **run_kwargs)
        await self._capture_async(user_prompt, result.output, identity)
        return result
```

`_recall_async` and `_capture_async` catch only `GatewayError`. In strict mode re-raise; otherwise log an operation-only warning. `_capture_async` must call `acapture` exactly once and only after `Agent.run` returns successfully.

- [ ] **Step 5: Export and run async tests**

Update `__init__.py` to export `TencentDBMemoryAgent`. Run:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_agent.py" -v
```

Expected: async lifecycle tests pass.

- [ ] **Step 6: Commit**

```powershell
git add pydantic-ai-plugin/src pydantic-ai-plugin/tests/test_agent.py
git commit -m "feat(pydantic-ai): add automatic memory lifecycle"
```

---

### Task 5: Sync Lifecycle and Explicit Session End

**Files:**

- Modify: `pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/agent.py`
- Modify: `pydantic-ai-plugin/tests/test_agent.py`

- [ ] **Step 1: Add failing sync and session tests**

Add:

```python
class TencentDBMemoryAgentSyncTests(unittest.TestCase):
    def test_run_sync_matches_async_lifecycle(self) -> None:
        client = RecordingClient(context="Known preference")
        wrapped = TencentDBMemoryAgent(
            Agent(TestModel(custom_output_text="answer")), client
        )
        result = wrapped.run_sync("question", user_id="u", session_id="s")
        self.assertEqual(result.output, "answer")
        self.assertEqual(client.events, ["recall", "capture"])

    def test_end_session_sync_returns_flushed(self) -> None:
        client = RecordingClient(flushed=True)
        wrapped = TencentDBMemoryAgent(Agent(TestModel()), client)
        self.assertTrue(
            wrapped.end_session_sync(user_id="u", session_id="s")
        )
```

Async tests must also cover `end_session`, explicit session-key overrides, fail-open returning `False`, and strict errors propagating.

- [ ] **Step 2: Run and verify missing methods**

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_agent.py" -v
```

Expected: failures because `run_sync`, `end_session`, and `end_session_sync` do not exist.

- [ ] **Step 3: Implement sync and session APIs**

Add `run_sync` with the same validation, identity, instruction merge, toolset merge, exactly-once capture, and strict semantics as `run`, but call synchronous client methods and `self._agent.run_sync`.

Add:

```python
async def end_session(
    self,
    *,
    user_id: str,
    session_id: str,
    session_key: str | None = None,
) -> bool:
    identity = MemoryIdentity.create(user_id, session_id, session_key=session_key)
    try:
        response = await self._client.aend_session(
            identity.session_key, identity.user_id
        )
        return bool(response["flushed"])
    except GatewayError as exc:
        if self._strict:
            raise
        logger.warning("TencentDB session end unavailable: %s", exc)
        return False
```

Implement `end_session_sync` with identical semantics using `client.end_session`.

- [ ] **Step 4: Run all Python tests and commit**

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -v
git add pydantic-ai-plugin/src/memory_tencentdb_pydantic_ai/agent.py pydantic-ai-plugin/tests/test_agent.py
git commit -m "feat(pydantic-ai): support sync runs and session end"
```

Expected: all Python tests pass.

---

### Task 6: Offline and DeepSeek Demonstrations

**Files:**

- Create: `pydantic-ai-plugin/examples/offline_memory_demo.py`
- Create: `pydantic-ai-plugin/examples/deepseek_memory_demo.py`
- Create: `pydantic-ai-plugin/tests/test_examples.py`

- [ ] **Step 1: Add example smoke tests**

Create tests that run the offline example in a subprocess with `ALLOW_MODEL_REQUESTS=False` and import the DeepSeek example without `DEEPSEEK_API_KEY`. Assert the offline output contains:

```text
recall -> agent -> capture -> session_end
```

Assert importing the DeepSeek module does not make a network request and its `main()` raises a clear error when the key is missing.

- [ ] **Step 2: Run and verify the example tests fail**

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_examples.py" -v
```

Expected: missing example file failures.

- [ ] **Step 3: Implement the offline example**

Use the package's test-style local fake Gateway logic and:

```python
agent = Agent(TestModel(custom_output_text="I remembered your preference."))
memory_agent = TencentDBMemoryAgent(agent, GatewayClient(gateway.url))
result = memory_agent.run_sync(
    "I prefer sugar-free coffee.",
    user_id="demo-user",
    session_id="offline-demo",
)
flushed = memory_agent.end_session_sync(
    user_id="demo-user", session_id="offline-demo"
)
```

Print only endpoint lifecycle and the model result, not headers or secrets.

- [ ] **Step 4: Implement the real DeepSeek example**

Use the official provider alias:

```python
api_key = os.environ.get("DEEPSEEK_API_KEY")
if not api_key:
    raise RuntimeError("Set DEEPSEEK_API_KEY in your local environment")

agent = Agent(
    os.environ.get("PYDANTIC_AI_MODEL", "deepseek:deepseek-chat"),
    instructions="Answer concisely and use recalled memory when relevant.",
)
memory_agent = TencentDBMemoryAgent(
    agent,
    GatewayClient(
        os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420"),
        api_key=os.environ.get("TDAI_GATEWAY_API_KEY"),
    ),
)
```

Run two turns with the same `user_id` and `session_id`, passing `message_history=result.new_messages()` into the second run. First store a non-sensitive demo preference; then ask for it. End the session explicitly.

- [ ] **Step 5: Run smoke tests and commit**

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -p "test_examples.py" -v
.\.venv\Scripts\python.exe pydantic-ai-plugin/examples/offline_memory_demo.py
git add pydantic-ai-plugin/examples pydantic-ai-plugin/tests/test_examples.py
git commit -m "feat(pydantic-ai): add offline and DeepSeek demos"
```

Expected: tests pass and offline output shows the complete lifecycle.

---

### Task 7: English and Chinese Adapter Documentation

**Files:**

- Modify: `pydantic-ai-plugin/README.md`
- Create: `pydantic-ai-plugin/README_CN.md`
- Modify: `README.md`
- Modify: `README_CN.md`

- [ ] **Step 1: Write complete adapter documentation**

Both adapter READMEs must include:

1. architecture diagram and OpenClaw/Hermes/PydanticAI lifecycle table;
2. Python 3.11 installation;
3. Gateway startup and health check;
4. async and sync quick starts;
5. automatic recall/capture behavior;
6. `memory_search` and `conversation_search`;
7. identity and percent-encoded session key;
8. fail-open and `strict=True`;
9. timeout and retry policy, explicitly noting no capture retry;
10. localhost, Bearer authentication, HTTPS, and application authorization boundaries;
11. offline and DeepSeek commands;
12. limitations: text prompts, non-streaming runs, one new platform, no universal SDK;
13. troubleshooting for 401, connection errors, absent memory context, and missing DeepSeek key.

The DeepSeek command must use environment variables:

```powershell
# DEEPSEEK_API_KEY must already be set in this terminal; never commit it.
$env:TDAI_GATEWAY_URL = "http://127.0.0.1:8420"
.\.venv\Scripts\python.exe pydantic-ai-plugin/examples/deepseek_memory_demo.py
```

- [ ] **Step 2: Add root README integration entries**

Add a concise “PydanticAI Adapter” section to both root READMEs. Link to the adapter README and mention:

- existing Gateway transport;
- automatic recall and successful-turn capture;
- explicit memory/conversation search tools;
- async/sync support;
- DeepSeek example.

Do not describe the adapter as a Tencent product or claim that two new platforms were implemented.

- [ ] **Step 3: Validate links and terminology**

Run:

```powershell
rg -n "PydanticAI|pydantic-ai-plugin|memory_search|conversation_search|strict=True|DEEPSEEK_API_KEY" README.md README_CN.md pydantic-ai-plugin/README.md pydantic-ai-plugin/README_CN.md
rg -n "TO[D]O|T[B]D|FIX[M]E|your-deepseek-api-key" pydantic-ai-plugin README.md README_CN.md
```

Expected: required concepts are present; placeholder/embedded-key scan returns no matches.

- [ ] **Step 4: Commit**

```powershell
git add README.md README_CN.md pydantic-ai-plugin/README.md pydantic-ai-plugin/README_CN.md
git commit -m "docs(pydantic-ai): add adapter guide"
```

---

### Task 8: npm Packaging and Python Wheel Validation

**Files:**

- Modify: `package.json`
- Potentially modify: `pydantic-ai-plugin/pyproject.toml` only if wheel inspection reveals missing intended files.

- [ ] **Step 1: Add PydanticAI package to npm files**

Add `"pydantic-ai-plugin/"` to `package.json`'s `files` list, then add exclusions:

```json
"!pydantic-ai-plugin/tests/",
"!pydantic-ai-plugin/.venv/",
"!pydantic-ai-plugin/build/",
"!pydantic-ai-plugin/**/*.egg-info/"
```

- [ ] **Step 2: Build and inspect the Python wheel**

Run:

```powershell
.\.venv\Scripts\python.exe -m build pydantic-ai-plugin
.\.venv\Scripts\python.exe -m zipfile -l pydantic-ai-plugin\dist\memory_tencentdb_pydantic_ai-0.1.0-py3-none-any.whl
```

Expected: the wheel contains the six public package modules and metadata, with no tests, `.env`, keys, or cache files.

- [ ] **Step 3: Inspect npm dry-run contents**

Run:

```powershell
npm pack --dry-run --json
```

Expected: JSON output includes `pydantic-ai-plugin/pyproject.toml`, source files, examples, and READMEs; it excludes Python tests, `.venv`, `dist`, caches, and secrets.

- [ ] **Step 4: Add an automated packaging assertion if needed**

If npm exclusions behave differently than expected, add exact `files` negations to `package.json` and repeat the dry run until the evidence matches the expected manifest.

- [ ] **Step 5: Commit**

```powershell
git add package.json pydantic-ai-plugin/pyproject.toml
git commit -m "build: package PydanticAI adapter"
```

---

### Task 9: Full Verification and Real DeepSeek Smoke Test

**Files:**

- Modify only files implicated by a failing verification.
- Do not commit logs, API keys, captured private conversations, wheels, or npm tarballs.

- [ ] **Step 1: Run the complete Python suite in network-blocking mode**

Set PydanticAI model requests off inside test setup, then run:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s pydantic-ai-plugin/tests -v
```

Expected: all tests pass with no external model request.

- [ ] **Step 2: Run repository tests and builds**

```powershell
npm test
npm run build
.\.venv\Scripts\python.exe -m build pydantic-ai-plugin
npm pack --dry-run
git diff --check
git status --short
```

Expected: all commands exit zero. Only intentionally generated ignored build artifacts may exist.

- [ ] **Step 3: Run the credential-free lifecycle demo**

```powershell
.\.venv\Scripts\python.exe pydantic-ai-plugin/examples/offline_memory_demo.py
```

Expected: output proves recall, agent execution, capture, and session end in that order.

- [ ] **Step 4: Run the real DeepSeek demo**

Before running, check only whether `DEEPSEEK_API_KEY` exists; never print it:

```powershell
if (-not $env:DEEPSEEK_API_KEY) { throw "DEEPSEEK_API_KEY is not set in this terminal" }
.\.venv\Scripts\python.exe pydantic-ai-plugin/examples/deepseek_memory_demo.py
```

Expected: two successful DeepSeek turns and explicit session flush. If the Gateway lacks extracted memory because local extraction is disabled, the test still proves real Agent/Gateway recall and capture transport; do not falsely claim semantic recall unless the second result demonstrates it.

- [ ] **Step 5: Record verification evidence in the PR body, not the repository**

Summarize command names and pass counts. Redact the API key and use only non-sensitive demo prompts.

- [ ] **Step 6: Route any verification failure back to its owning task**

If verification changes a file, rerun that task's focused test and its commit step before repeating the complete verification. If no file changes, create no extra commit.

---

### Task 10: Fork, Push, PR, and Initial CI Inspection

**Files:**

- No additional source files unless PR inspection finds a concrete issue.

- [ ] **Step 1: Audit the final branch**

```powershell
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: clean worktree, focused commits, no whitespace errors.

- [ ] **Step 2: Create or verify the contributor fork**

Use authenticated GitHub CLI:

```powershell
gh repo fork TencentCloud/TencentDB-Agent-Memory --clone=false --remote=false
```

Verify `lazymo1028/TencentDB-Agent-Memory` exists before changing remotes.

- [ ] **Step 3: Configure remotes safely**

Keep the official repository as `upstream` and the contributor fork as `origin`:

```powershell
git remote rename origin upstream
git remote add origin https://github.com/lazymo1028/TencentDB-Agent-Memory.git
git remote -v
```

Expected: `origin` points to `lazymo1028`; `upstream` points to `TencentCloud`.

- [ ] **Step 4: Push the feature branch**

```powershell
git -c http.proxy=http://127.0.0.1:10808 -c https.proxy=http://127.0.0.1:10808 push -u origin issue-235-pydantic-ai-adapter
```

- [ ] **Step 5: Open a ready-for-review PR**

PR title:

```text
feat: add PydanticAI adapter for Agent Memory Gateway
```

PR body must include:

- `Closes` is not used because #235 is a shared umbrella issue;
- `Related to #235`;
- architecture and endpoint mapping;
- automatic recall/capture and explicit search/session behavior;
- fail-open/strict and capture no-retry semantics;
- test commands and observed counts;
- offline demo evidence;
- real DeepSeek result only if actually executed;
- explicit intermediate-stage acceptance claim.

Target `TencentCloud/TencentDB-Agent-Memory:main` from `lazymo1028:issue-235-pydantic-ai-adapter`.

- [ ] **Step 6: Inspect the published PR**

Verify:

```powershell
gh pr view --repo TencentCloud/TencentDB-Agent-Memory --json url,state,isDraft,baseRefName,headRefName,body,files,statusCheckRollup
gh pr diff --repo TencentCloud/TencentDB-Agent-Memory --name-only
```

Expected: open, not draft, correct base/head, no secret files, intended file list only.

- [ ] **Step 7: Inspect initial checks**

```powershell
gh pr checks --repo TencentCloud/TencentDB-Agent-Memory --watch
```

If checks fail, inspect logs before changing code. Apply only evidence-backed fixes, rerun the relevant local command, commit, and push.

---

## Final Completion Audit

Before declaring completion, gather direct evidence for every design requirement:

- [ ] Package public API imports from a clean environment.
- [ ] Identity/session behavior is unit-tested.
- [ ] Every Gateway route used by the adapter is transport-tested.
- [ ] Bearer auth, URL validation, timeout, error typing, and secret redaction are tested.
- [ ] Capture is demonstrably not retried.
- [ ] Automatic recall precedes each Agent run.
- [ ] Capture occurs exactly once and only after a successful Agent result.
- [ ] Existing runtime instructions, history, and toolsets are preserved.
- [ ] Search tools work and honor fail-open/strict behavior.
- [ ] Async and sync APIs have equivalent lifecycle behavior.
- [ ] Structured output serialization is verified.
- [ ] Explicit session end is verified.
- [ ] Offline demo completes without credentials.
- [ ] Real DeepSeek evidence is reported only if actually observed.
- [ ] English/Chinese documentation matches implemented behavior.
- [ ] Python wheel and npm manifest contain intended files and no secrets/tests/build output.
- [ ] Python tests, npm tests, TypeScript build, wheel build, npm dry run, and diff checks pass.
- [ ] Fork branch exists and the official PR is open, ready, correctly targeted, and inspected.
- [ ] Initial GitHub checks are green, or any external pending state is reported precisely without claiming success.
