# PydanticAI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independently installable PydanticAI 2.x capability that automatically recalls and captures TencentDB Agent Memory, exposes search tools, and flushes sessions through the existing TDAI Gateway.

**Architecture:** A small asynchronous Python Gateway client owns HTTP serialization, authentication, timeouts, and typed failures. A PydanticAI `AbstractCapability` owns platform lifecycle mapping, creates isolated per-run state with `for_run()`, injects recall through dynamic instructions, captures successful results through `after_run()`, and supplies search tools through `FunctionToolset`.

**Tech Stack:** Python 3.10+, PydanticAI `>=2.0,<3`, standard-library `urllib` and `asyncio`, pytest, pytest-asyncio, TypeScript/Vitest for repository regression verification, GitHub Actions.

## Global Constraints

- Keep the adapter under `pydantic-ai-adapter/`; it must not become a runtime dependency of the root Node package.
- Use only public PydanticAI APIs: `AbstractCapability`, `RunContext`, `FunctionToolset`, `AgentRunResult`, `for_run`, `get_instructions`, `get_toolset`, and `after_run`.
- Reuse the existing Gateway wire contract without modifying `TdaiCore`, Gateway routes, OpenClaw, or Hermes.
- Target Python `>=3.10` and `pydantic-ai>=2.0,<3`.
- Use Python's standard-library HTTP stack behind `asyncio.to_thread`; do not add an HTTP client dependency.
- Treat recall, automatic capture, and search failures as fail-open; invalid session resolution remains a configuration error.
- Never log Bearer tokens or complete user/assistant content.
- Keep this a single-platform contribution; do not add a generic TypeScript SDK or another Agent adapter.
- Every implementation commit must use DCO sign-off via `git commit -s`.

---

## File Map

**Create**

- `pydantic-ai-adapter/pyproject.toml` — nested Python package metadata and test configuration.
- `pydantic-ai-adapter/src/tdai_pydantic_ai/__init__.py` — stable public exports.
- `pydantic-ai-adapter/src/tdai_pydantic_ai/client.py` — Gateway protocol, async client, and typed error.
- `pydantic-ai-adapter/src/tdai_pydantic_ai/capability.py` — PydanticAI lifecycle, identity resolution, prompt/output conversion, and search tools.
- `pydantic-ai-adapter/tests/conftest.py` — local HTTP server and fake-client fixtures.
- `pydantic-ai-adapter/tests/test_client.py` — request mapping, auth, response, and error tests.
- `pydantic-ai-adapter/tests/test_capability.py` — recall, capture, tools, failure policy, and concurrency tests.
- `pydantic-ai-adapter/README.md` — package installation and usage.
- `docs/adapters/pydantic-ai.md` — issue acceptance documentation and architecture/data-flow diagrams.

**Modify**

- `.gitignore` — ignore the local Python virtual environment and pytest caches.
- `.github/workflows/pr-ci.yml` — add an isolated Python adapter test job.
- `README.md` — link the PydanticAI adapter guide.
- `README_CN.md` — add the matching Chinese documentation link.

---

### Task 1: Package Scaffold and Typed Gateway Client

**Files:**

- Create: `pydantic-ai-adapter/pyproject.toml`
- Create: `pydantic-ai-adapter/README.md`
- Create: `pydantic-ai-adapter/src/tdai_pydantic_ai/__init__.py`
- Create: `pydantic-ai-adapter/src/tdai_pydantic_ai/client.py`
- Create: `pydantic-ai-adapter/tests/conftest.py`
- Create: `pydantic-ai-adapter/tests/test_client.py`
- Modify: `.gitignore`

**Interfaces:**

- Produces: `TdaiGatewayError(path: str, message: str, status: int | None = None, response_body: str | None = None)`.
- Produces: `GatewayClientProtocol` with async `health`, `recall`, `capture`, `search_memories`, `search_conversations`, and `end_session` methods.
- Produces: `TdaiGatewayClient(base_url="http://127.0.0.1:8420", timeout=10.0, api_key=None)`.
- All client methods return `dict[str, Any]`; all operational failures raise `TdaiGatewayError`.

- [ ] **Step 1: Add package metadata and test dependencies**

Create `pydantic-ai-adapter/pyproject.toml`:

```toml
[build-system]
requires = ["hatchling>=1.27"]
build-backend = "hatchling.build"

[project]
name = "tdai-pydantic-ai-adapter"
version = "0.1.0"
description = "PydanticAI capability for TencentDB Agent Memory"
readme = "README.md"
requires-python = ">=3.10"
license = { text = "MIT" }
dependencies = ["pydantic-ai>=2.0,<3"]

[project.optional-dependencies]
test = [
  "pytest>=8.3,<9",
  "pytest-asyncio>=0.25,<1",
]

[tool.hatch.build.targets.wheel]
packages = ["src/tdai_pydantic_ai"]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

Append these entries to `.gitignore`:

```gitignore
# Local Python development environments and test caches
.venv-pydantic-ai/
.pytest_cache/
```

Create a minimal package README containing the title, one-sentence purpose, and
the command `pip install -e ".[test]"` so the build backend has its declared
readme file.

- [ ] **Step 2: Create the isolated environment**

Run:

```powershell
py -3.11 -m venv .venv-pydantic-ai
.\.venv-pydantic-ai\Scripts\python.exe -m pip install -e "pydantic-ai-adapter[test]"
```

Expected: installation succeeds and imports PydanticAI 2.x.

- [ ] **Step 3: Write the failing route/auth test**

In `pydantic-ai-adapter/tests/conftest.py`, define a `ThreadingHTTPServer`
fixture whose handler records method, path, headers, and decoded JSON body in a
thread-safe queue, then returns a configurable status/body:

```python
from __future__ import annotations

import json
import threading
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from typing import Any

import pytest


@dataclass
class RecordedRequest:
    method: str
    path: str
    headers: Mapping[str, str]
    body: dict[str, Any] | None


@dataclass
class GatewayStub:
    base_url: str
    requests: Queue[RecordedRequest]
    responses: Queue[tuple[int, object, str]]


@pytest.fixture
def gateway_stub() -> Iterator[GatewayStub]:
    requests: Queue[RecordedRequest] = Queue()
    responses: Queue[tuple[int, object, str]] = Queue()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self._handle()

        def do_POST(self) -> None:
            self._handle()

        def _handle(self) -> None:
            length = int(self.headers.get("Content-Length", "0"))
            raw_request = self.rfile.read(length)
            body = json.loads(raw_request) if raw_request else None
            requests.put(RecordedRequest(
                method=self.command,
                path=self.path,
                headers=dict(self.headers.items()),
                body=body,
            ))

            status, payload, content_type = responses.get_nowait()
            if isinstance(payload, bytes):
                raw_response = payload
            elif isinstance(payload, str):
                raw_response = payload.encode("utf-8")
            else:
                raw_response = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(raw_response)))
            self.end_headers()
            self.wfile.write(raw_response)

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        yield GatewayStub(
            base_url=f"http://{host}:{port}",
            requests=requests,
            responses=responses,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
```

Add `test_recall_maps_request_and_bearer_auth`:

```python
async def test_recall_maps_request_and_bearer_auth(gateway_stub: GatewayStub) -> None:
    gateway_stub.responses.put((200, {"context": "remembered"}, "application/json"))
    client = TdaiGatewayClient(
        gateway_stub.base_url,
        timeout=1,
        api_key="  secret-token  ",
    )

    result = await client.recall("where is it?", "session-1", "user-7")

    request = gateway_stub.requests.get_nowait()
    assert result == {"context": "remembered"}
    assert request.method == "POST"
    assert request.path == "/recall"
    assert request.headers["Authorization"] == "Bearer secret-token"
    assert request.body == {
        "query": "where is it?",
        "session_key": "session-1",
        "user_id": "user-7",
    }
```

- [ ] **Step 4: Run the test and observe the missing implementation**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pytest pydantic-ai-adapter/tests/test_client.py::test_recall_maps_request_and_bearer_auth -q
```

Expected: FAIL during import because `TdaiGatewayClient` is not implemented.

- [ ] **Step 5: Implement the client contract and request core**

Create `client.py` with:

```python
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from typing import Any, Protocol, runtime_checkable


class TdaiGatewayError(RuntimeError):
    def __init__(
        self,
        path: str,
        message: str,
        *,
        status: int | None = None,
        response_body: str | None = None,
    ) -> None:
        self.path = path
        self.status = status
        self.response_body = response_body
        detail = f"{message} [{path}]"
        if status is not None:
            detail += f" (HTTP {status})"
        super().__init__(detail)


@runtime_checkable
class GatewayClientProtocol(Protocol):
    async def health(self) -> dict[str, Any]: ...
    async def recall(
        self, query: str, session_key: str, user_id: str = ""
    ) -> dict[str, Any]: ...
    async def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str = "",
        user_id: str = "",
    ) -> dict[str, Any]: ...
    async def search_memories(
        self,
        query: str,
        limit: int = 5,
        type_filter: str = "",
        scene: str = "",
    ) -> dict[str, Any]: ...
    async def search_conversations(
        self, query: str, limit: int = 5, session_key: str = ""
    ) -> dict[str, Any]: ...
    async def end_session(
        self, session_key: str, user_id: str = ""
    ) -> dict[str, Any]: ...


class TdaiGatewayClient:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8420",
        *,
        timeout: float = 10.0,
        api_key: str | None = None,
    ) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._api_key = (api_key or "").strip() or None

    async def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(self._request_sync, method, path, body)

    def _request_sync(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")[:500]
            raise TdaiGatewayError(
                path,
                "Gateway rejected the request",
                status=error.code,
                response_body=raw,
            ) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise TdaiGatewayError(path, "Gateway request failed") from error
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as error:
            raise TdaiGatewayError(path, "Gateway returned malformed JSON") from error
        if not isinstance(parsed, dict):
            raise TdaiGatewayError(path, "Gateway returned a non-object JSON response")
        return parsed
```

Implement the public route methods, omitting optional fields when their value
is empty:

```python
async def health(self) -> dict[str, Any]:
    return await self._request("GET", "/health")

async def recall(self, query: str, session_key: str, user_id: str = "") -> dict[str, Any]:
    body: dict[str, Any] = {"query": query, "session_key": session_key}
    if user_id:
        body["user_id"] = user_id
    return await self._request("POST", "/recall", body)

async def capture(
    self,
    user_content: str,
    assistant_content: str,
    session_key: str,
    session_id: str = "",
    user_id: str = "",
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "user_content": user_content,
        "assistant_content": assistant_content,
        "session_key": session_key,
    }
    if session_id:
        body["session_id"] = session_id
    if user_id:
        body["user_id"] = user_id
    return await self._request("POST", "/capture", body)

async def search_memories(
    self,
    query: str,
    limit: int = 5,
    type_filter: str = "",
    scene: str = "",
) -> dict[str, Any]:
    body: dict[str, Any] = {"query": query, "limit": limit}
    if type_filter:
        body["type"] = type_filter
    if scene:
        body["scene"] = scene
    return await self._request("POST", "/search/memories", body)

async def search_conversations(
    self,
    query: str,
    limit: int = 5,
    session_key: str = "",
) -> dict[str, Any]:
    body: dict[str, Any] = {"query": query, "limit": limit}
    if session_key:
        body["session_key"] = session_key
    return await self._request("POST", "/search/conversations", body)

async def end_session(
    self,
    session_key: str,
    user_id: str = "",
) -> dict[str, Any]:
    body: dict[str, Any] = {"session_key": session_key}
    if user_id:
        body["user_id"] = user_id
    return await self._request("POST", "/session/end", body)
```

- [ ] **Step 6: Run the route/auth test**

Run the command from Step 4.

Expected: PASS.

- [ ] **Step 7: Add complete route-mapping and error tests**

Add parameterized tests for:

- `GET /health`;
- `POST /capture`, including `session_id` and `user_id`;
- `POST /search/memories`, including `type` and `scene`;
- `POST /search/conversations`, including `session_key`;
- `POST /session/end`;
- no `Authorization` header when the key is empty;
- HTTP 401 becoming `TdaiGatewayError` with `path == "/recall"` and
  `status == 401`;
- malformed JSON becoming `TdaiGatewayError`;
- a JSON list becoming `TdaiGatewayError`;
- a refused local connection becoming `TdaiGatewayError` with no raw URL or
  credentials in its message;
- a delayed local response exceeding a short positive timeout becoming
  `TdaiGatewayError`;
- `timeout=0` raising `ValueError`.

The HTTP error assertion must verify the exception string contains the route
and status but not `"secret-token"`.

- [ ] **Step 8: Run all client tests**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pytest pydantic-ai-adapter/tests/test_client.py -q
```

Expected: all client tests PASS.

- [ ] **Step 9: Export the public client API**

Create `__init__.py`:

```python
from .client import GatewayClientProtocol, TdaiGatewayClient, TdaiGatewayError

__all__ = [
    "GatewayClientProtocol",
    "TdaiGatewayClient",
    "TdaiGatewayError",
]
```

- [ ] **Step 10: Commit the client**

```powershell
git add .gitignore pydantic-ai-adapter
git commit -s -m "feat(pydantic-ai): add typed gateway client"
```

---

### Task 2: Automatic Recall, Capture, and Run Isolation

**Files:**

- Create: `pydantic-ai-adapter/src/tdai_pydantic_ai/capability.py`
- Create: `pydantic-ai-adapter/tests/test_capability.py`
- Modify: `pydantic-ai-adapter/src/tdai_pydantic_ai/__init__.py`

**Interfaces:**

- Consumes: `GatewayClientProtocol` and `TdaiGatewayClient` from Task 1.
- Produces: `Resolver = str | Callable[[RunContext[Any]], str | Awaitable[str]]`.
- Produces: `TencentDBMemoryCapability(session_key, user_id="default_user", base_url="http://127.0.0.1:8420", timeout=10.0, api_key=None, client=None)`.
- Produces: private `_prompt_text(prompt) -> str` and `_output_text(output) -> str`.

- [ ] **Step 1: Add a fake client fixture**

In `test_capability.py`, define:

```python
@dataclass
class FakeGatewayClient:
    recall_context: str = "Remembered preference"
    fail_routes: set[str] = field(default_factory=set)
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    async def recall(self, query: str, session_key: str, user_id: str = "") -> dict[str, Any]:
        self.calls.append(("recall", {
            "query": query,
            "session_key": session_key,
            "user_id": user_id,
        }))
        if "recall" in self.fail_routes:
            raise TdaiGatewayError("/recall", "unavailable")
        return {"context": self.recall_context}

    async def capture(
        self,
        user_content: str,
        assistant_content: str,
        session_key: str,
        session_id: str = "",
        user_id: str = "",
    ) -> dict[str, Any]:
        self.calls.append(("capture", {
            "user_content": user_content,
            "assistant_content": assistant_content,
            "session_key": session_key,
            "session_id": session_id,
            "user_id": user_id,
        }))
        if "capture" in self.fail_routes:
            raise TdaiGatewayError("/capture", "unavailable")
        return {"l0_recorded": 2, "scheduler_notified": True}

    async def search_memories(
        self,
        query: str,
        limit: int = 5,
        type_filter: str = "",
        scene: str = "",
    ) -> dict[str, Any]:
        self.calls.append(("search_memories", {
            "query": query,
            "limit": limit,
            "type_filter": type_filter,
            "scene": scene,
        }))
        if "search_memories" in self.fail_routes:
            raise TdaiGatewayError("/search/memories", "unavailable")
        return {"results": "memory result", "total": 1, "strategy": "hybrid"}

    async def search_conversations(
        self,
        query: str,
        limit: int = 5,
        session_key: str = "",
    ) -> dict[str, Any]:
        self.calls.append(("search_conversations", {
            "query": query,
            "limit": limit,
            "session_key": session_key,
        }))
        if "search_conversations" in self.fail_routes:
            raise TdaiGatewayError("/search/conversations", "unavailable")
        return {"results": "conversation result", "total": 1}

    async def health(self) -> dict[str, Any]:
        self.calls.append(("health", {}))
        if "health" in self.fail_routes:
            raise TdaiGatewayError("/health", "unavailable")
        return {"status": "ok"}

    async def end_session(
        self,
        session_key: str,
        user_id: str = "",
    ) -> dict[str, Any]:
        self.calls.append(("end_session", {
            "session_key": session_key,
            "user_id": user_id,
        }))
        if "end_session" in self.fail_routes:
            raise TdaiGatewayError("/session/end", "unavailable")
        return {"flushed": True}
```

- [ ] **Step 2: Write the failing recall/capture integration test**

Use PydanticAI's `FunctionModel` to inspect instructions without a real model:

```python
@dataclass
class RunDeps:
    session_key: str
    user_id: str


async def test_recall_is_injected_and_successful_run_is_captured() -> None:
    fake = FakeGatewayClient()
    seen_instructions: list[str | None] = []

    async def model_function(messages, info):
        seen_instructions.append(info.instructions)
        return ModelResponse(parts=[TextPart("final answer")])

    memory = TencentDBMemoryCapability(
        client=fake,
        session_key=lambda ctx: ctx.deps.session_key,
        user_id=lambda ctx: ctx.deps.user_id,
    )
    agent = Agent(
        FunctionModel(model_function),
        deps_type=RunDeps,
        capabilities=[memory],
    )

    result = await agent.run(
        "remember my editor",
        deps=RunDeps(session_key="session-a", user_id="user-a"),
    )

    assert result.output == "final answer"
    assert seen_instructions == ["Remembered preference"]
    assert fake.calls == [
        ("recall", {
            "query": "remember my editor",
            "session_key": "session-a",
            "user_id": "user-a",
        }),
        ("capture", {
            "user_content": "remember my editor",
            "assistant_content": "final answer",
            "session_key": "session-a",
            "session_id": "",
            "user_id": "user-a",
        }),
    ]
```

- [ ] **Step 3: Run the test and observe the missing capability**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pytest pydantic-ai-adapter/tests/test_capability.py::test_recall_is_injected_and_successful_run_is_captured -q
```

Expected: FAIL because `TencentDBMemoryCapability` does not exist.

- [ ] **Step 4: Implement identity resolution and text conversion**

In `capability.py`, add:

```python
from __future__ import annotations

import copy
import inspect
import json
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, TypeAlias

from pydantic_ai import AgentRunResult, RunContext
from pydantic_ai.capabilities import AbstractCapability

from .client import GatewayClientProtocol, TdaiGatewayClient, TdaiGatewayError

logger = logging.getLogger(__name__)

Resolver: TypeAlias = str | Callable[[RunContext[Any]], str | Awaitable[str]]


async def _resolve(resolver: Resolver, ctx: RunContext[Any], label: str) -> str:
    value = resolver(ctx) if callable(resolver) else resolver
    if inspect.isawaitable(value):
        value = await value
    resolved = str(value).strip()
    if label == "session key" and not resolved:
        raise ValueError("TencentDB memory session key must not be empty")
    return resolved


def _prompt_text(prompt: object) -> str:
    if isinstance(prompt, str):
        return prompt.strip()
    if isinstance(prompt, Sequence) and not isinstance(prompt, (bytes, bytearray)):
        return "\n".join(item.strip() for item in prompt if isinstance(item, str) and item.strip())
    return ""


def _output_text(output: object) -> str:
    if isinstance(output, str):
        return output
    if hasattr(output, "model_dump"):
        output = output.model_dump(mode="json")
    try:
        return json.dumps(output, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(output)
```

- [ ] **Step 5: Implement the capability lifecycle**

Add the capability with run-scoped state:

```python
class TencentDBMemoryCapability(AbstractCapability[Any]):
    def __init__(
        self,
        *,
        session_key: Resolver,
        user_id: Resolver = "default_user",
        base_url: str = "http://127.0.0.1:8420",
        timeout: float = 10.0,
        api_key: str | None = None,
        client: GatewayClientProtocol | None = None,
    ) -> None:
        self._session_resolver = session_key
        self._user_resolver = user_id
        self._client = client or TdaiGatewayClient(
            base_url,
            timeout=timeout,
            api_key=api_key,
        )
        self._resolved_session_key = ""
        self._resolved_user_id = ""
        self._recall_loaded = False
        self._recall_context = ""

    async def for_run(self, ctx: RunContext[Any]) -> "TencentDBMemoryCapability":
        run_capability = copy.copy(self)
        run_capability._resolved_session_key = await _resolve(
            self._session_resolver, ctx, "session key"
        )
        run_capability._resolved_user_id = await _resolve(
            self._user_resolver, ctx, "user ID"
        )
        run_capability._recall_loaded = False
        run_capability._recall_context = ""
        return run_capability

    def get_instructions(self):
        async def recall(ctx: RunContext[Any]) -> str:
            if self._recall_loaded:
                return self._recall_context
            self._recall_loaded = True
            query = _prompt_text(ctx.prompt)
            if not query:
                return ""
            try:
                response = await self._client.recall(
                    query,
                    self._resolved_session_key,
                    self._resolved_user_id,
                )
                context = response.get("context", "")
                self._recall_context = context if isinstance(context, str) else ""
            except TdaiGatewayError as error:
                logger.warning("TencentDB memory recall unavailable: %s", error)
            return self._recall_context

        return recall

    async def after_run(
        self,
        ctx: RunContext[Any],
        *,
        result: AgentRunResult[Any],
    ) -> AgentRunResult[Any]:
        user_text = _prompt_text(ctx.prompt)
        assistant_text = _output_text(result.output)
        if user_text and assistant_text:
            try:
                await self._client.capture(
                    user_text,
                    assistant_text,
                    self._resolved_session_key,
                    user_id=self._resolved_user_id,
                )
            except TdaiGatewayError as error:
                logger.warning("TencentDB memory capture unavailable: %s", error)
        return result
```

- [ ] **Step 6: Run the recall/capture integration test**

Run the command from Step 3.

Expected: PASS.

- [ ] **Step 7: Add conversion, fail-open, and structured-output tests**

Add tests proving:

- a recall failure leaves `info.instructions` empty and still returns the model
  result;
- a multi-step run that performs a tool call receives the same cached recall
  context on later model requests while the fake records exactly one recall;
- a capture failure still returns the model result;
- an empty static session key raises `ValueError` before the model function is
  called;
- a Pydantic output model is captured as sorted compact JSON;
- a prompt sequence captures only its textual string members;
- a prompt with no textual content skips recall and capture.

Use `caplog` to assert failure logs name only the route and do not include the
prompt, assistant output, or API key.

- [ ] **Step 8: Add concurrent-run isolation test**

Share one capability across one reusable Agent and run two calls with
`asyncio.gather`. The fake client should insert a small await in `recall`.
Assert each capture uses the same session/user pair as its preceding recall and
that neither run receives the other run's recalled context.

- [ ] **Step 9: Run capability and client tests**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pytest pydantic-ai-adapter/tests -q
```

Expected: all tests PASS.

- [ ] **Step 10: Export the capability**

Update `__init__.py`:

```python
from .capability import Resolver, TencentDBMemoryCapability
from .client import GatewayClientProtocol, TdaiGatewayClient, TdaiGatewayError

__all__ = [
    "GatewayClientProtocol",
    "Resolver",
    "TdaiGatewayClient",
    "TdaiGatewayError",
    "TencentDBMemoryCapability",
]
```

- [ ] **Step 11: Commit lifecycle integration**

```powershell
git add pydantic-ai-adapter
git commit -s -m "feat(pydantic-ai): add automatic recall and capture"
```

---

### Task 3: Search Tools and Session Management

**Files:**

- Modify: `pydantic-ai-adapter/src/tdai_pydantic_ai/capability.py`
- Modify: `pydantic-ai-adapter/tests/test_capability.py`

**Interfaces:**

- Consumes: run-scoped `TencentDBMemoryCapability` from Task 2.
- Produces: tools `tdai_memory_search` and `tdai_conversation_search`.
- Produces: `health() -> dict[str, Any]`.
- Produces: `end_session(session_key: str, user_id: str = "") -> dict[str, Any]`.

- [ ] **Step 1: Write failing tool registration and scoping test**

Use a `FunctionModel` that first returns a `ToolCallPart` for
`tdai_conversation_search`, then returns a final `TextPart` after seeing its
tool return:

```python
async def test_search_tools_are_registered_and_conversation_search_is_scoped() -> None:
    fake = FakeGatewayClient()
    seen_tool_names: list[list[str]] = []

    async def model_function(messages, info):
        seen_tool_names.append([tool.name for tool in info.function_tools])
        if not any(
            isinstance(part, ToolReturnPart)
            for message in messages
            if isinstance(message, ModelRequest)
            for part in message.parts
        ):
            return ModelResponse(parts=[
                ToolCallPart(
                    "tdai_conversation_search",
                    {"query": "deployment", "limit": 3},
                    tool_call_id="search-1",
                )
            ])
        return ModelResponse(parts=[TextPart("done")])

    memory = TencentDBMemoryCapability(client=fake, session_key="session-search")
    agent = Agent(FunctionModel(model_function), capabilities=[memory])
    await agent.run("find the deployment note")

    assert {
        "tdai_memory_search",
        "tdai_conversation_search",
    }.issubset(set(seen_tool_names[0]))
    assert ("search_conversations", {
        "query": "deployment",
        "limit": 3,
        "session_key": "session-search",
    }) in fake.calls
```

- [ ] **Step 2: Run the tool test and observe the missing tools**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pytest pydantic-ai-adapter/tests/test_capability.py::test_search_tools_are_registered_and_conversation_search_is_scoped -q
```

Expected: FAIL because neither search tool is registered.

- [ ] **Step 3: Implement the PydanticAI toolset**

Import `FunctionToolset` and add:

```python
def get_toolset(self):
    toolset = FunctionToolset()

    @toolset.tool
    async def tdai_memory_search(
        ctx: RunContext[Any],
        query: str,
        limit: int = 5,
        type: str = "",
        scene: str = "",
    ) -> str:
        """Search structured TencentDB Agent Memory records."""
        del ctx
        try:
            response = await self._client.search_memories(
                query,
                limit=limit,
                type_filter=type,
                scene=scene,
            )
            results = response.get("results", "")
            return results if isinstance(results, str) else json.dumps(
                response, ensure_ascii=False, sort_keys=True
            )
        except TdaiGatewayError as error:
            logger.warning("TencentDB structured memory search unavailable: %s", error)
            return "TencentDB memory search is temporarily unavailable."

    @toolset.tool
    async def tdai_conversation_search(
        ctx: RunContext[Any],
        query: str,
        limit: int = 5,
    ) -> str:
        """Search raw conversations in the current TencentDB memory session."""
        del ctx
        try:
            response = await self._client.search_conversations(
                query,
                limit=limit,
                session_key=self._resolved_session_key,
            )
            results = response.get("results", "")
            return results if isinstance(results, str) else json.dumps(
                response, ensure_ascii=False, sort_keys=True
            )
        except TdaiGatewayError as error:
            logger.warning("TencentDB conversation search unavailable: %s", error)
            return "TencentDB conversation search is temporarily unavailable."

    return toolset
```

- [ ] **Step 4: Run the tool test**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Add search mapping, validation, and failure tests**

Import and define the bounded tool argument:

```python
from typing import Annotated

from pydantic import Field

SearchLimit = Annotated[int, Field(ge=1, le=100)]
```

Change both search signatures to `limit: SearchLimit = 5`. Add tests proving:

- `tdai_memory_search` forwards `query`, `limit`, `type`, and `scene`;
- `limit=0` and `limit=101` are rejected before the Gateway call by adding
  `Annotated[int, Field(ge=1, le=100)]` to both tool signatures;
- structured-search failure returns
  `"TencentDB memory search is temporarily unavailable."`;
- conversation-search failure returns
  `"TencentDB conversation search is temporarily unavailable."`;
- error logs do not contain query text.

- [ ] **Step 6: Write failing health and session-end test**

```python
async def test_health_and_end_session_use_explicit_identity() -> None:
    fake = FakeGatewayClient()
    memory = TencentDBMemoryCapability(client=fake, session_key="run-session")

    assert await memory.health() == {"status": "ok"}
    assert await memory.end_session("conversation-9", "user-9") == {"flushed": True}
    assert fake.calls[-2:] == [
        ("health", {}),
        ("end_session", {
            "session_key": "conversation-9",
            "user_id": "user-9",
        }),
    ]
```

- [ ] **Step 7: Implement management APIs**

Add:

```python
async def health(self) -> dict[str, Any]:
    return await self._client.health()

async def end_session(
    self,
    session_key: str,
    user_id: str = "",
) -> dict[str, Any]:
    resolved_session_key = session_key.strip()
    if not resolved_session_key:
        raise ValueError("TencentDB memory session key must not be empty")
    return await self._client.end_session(resolved_session_key, user_id.strip())
```

Do not catch `TdaiGatewayError` in these explicit management calls.

- [ ] **Step 8: Run all Python adapter tests**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pytest pydantic-ai-adapter/tests -q
```

Expected: all tests PASS.

- [ ] **Step 9: Commit tools and management APIs**

```powershell
git add pydantic-ai-adapter
git commit -s -m "feat(pydantic-ai): expose memory search tools"
```

---

### Task 4: Adapter Documentation and Architecture Acceptance

**Files:**

- Create: `docs/adapters/pydantic-ai.md`
- Modify: `pydantic-ai-adapter/README.md`
- Modify: `README.md`
- Modify: `README_CN.md`

**Interfaces:**

- Documents the exact imports and methods produced by Tasks 1–3.
- Adds no new runtime behavior.

- [ ] **Step 1: Write the adapter guide**

Create `docs/adapters/pydantic-ai.md` with these concrete sections:

1. Scope and prerequisites: Python 3.10+, PydanticAI 2.x, and a running TDAI
   Gateway.
2. Architecture diagram showing `Agent -> TencentDBMemoryCapability ->
   TdaiGatewayClient -> Gateway -> TdaiCore -> stores`.
3. Recall data-flow diagram showing `agent.run -> for_run -> /recall ->
   dynamic instructions -> model`.
4. Capture data-flow diagram showing `successful result -> after_run ->
   /capture -> L0 -> pipeline`.
5. Installation command:

   ```bash
   pip install -e ./pydantic-ai-adapter
   ```

6. Minimal integration:

   ```python
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
       api_key="same value as TDAI_GATEWAY_API_KEY",
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

7. Search tool names and argument tables.
8. Authentication, timeout, failure behavior, session identity, concurrency,
   streaming-finalization, and troubleshooting.
9. Lifecycle comparison table:

   | Concern | OpenClaw | Hermes | PydanticAI |
   | --- | --- | --- | --- |
   | Recall | `before_prompt_build` | `prefetch()` | dynamic instructions |
   | Capture | `agent_end` | `sync_turn()` | `after_run()` |
   | Search | registered tools | Provider tools | `FunctionToolset` |
   | Session end | gateway shutdown/session hooks | `on_session_end()` | explicit `end_session()` |
   | Core transport | in-process | HTTP Gateway | HTTP Gateway |

- [ ] **Step 2: Expand the nested README**

Make `pydantic-ai-adapter/README.md` a concise standalone entry point containing:

- install command;
- the minimal integration example from the guide;
- environment-neutral Gateway URL and Bearer token configuration;
- links back to `../docs/adapters/pydantic-ai.md` and the root project README;
- test command `python -m pytest tests -q`.

- [ ] **Step 3: Add root documentation links**

Add this row to the Documentation table in `README.md`:

```markdown
| [`docs/adapters/pydantic-ai.md`](./docs/adapters/pydantic-ai.md) | PydanticAI capability adapter, lifecycle mapping, and setup |
```

Add the equivalent row to `README_CN.md`:

```markdown
| [`docs/adapters/pydantic-ai.md`](./docs/adapters/pydantic-ai.md) | PydanticAI Capability 适配、生命周期映射与接入说明 |
```

- [ ] **Step 4: Check documentation links and forbidden placeholders**

Run:

```powershell
rg -n "docs/adapters/pydantic-ai.md" README.md README_CN.md pydantic-ai-adapter/README.md
rg -n "TB[D]|TO[D]O|FIXM[E]|PLACEHOLDE[R]" docs/adapters/pydantic-ai.md pydantic-ai-adapter/README.md
```

Expected: the first command finds all intended links; the second exits with no
matches.

- [ ] **Step 5: Commit documentation**

```powershell
git add README.md README_CN.md docs/adapters/pydantic-ai.md pydantic-ai-adapter/README.md
git commit -s -m "docs(adapters): document PydanticAI integration"
```

---

### Task 5: Continuous Integration and Package Verification

**Files:**

- Modify: `.github/workflows/pr-ci.yml`
- Modify: `pydantic-ai-adapter/pyproject.toml` only if the clean CI install
  exposes a packaging metadata defect.

**Interfaces:**

- Produces a GitHub Actions job named `PydanticAI Adapter`.
- Changes no runtime API.

- [ ] **Step 1: Add the isolated Python CI job**

Append this job under `jobs` in `.github/workflows/pr-ci.yml`:

```yaml
  pydantic-ai-adapter:
    name: PydanticAI Adapter
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip
          cache-dependency-path: pydantic-ai-adapter/pyproject.toml

      - name: Install adapter
        run: python -m pip install -e "./pydantic-ai-adapter[test]"

      - name: Test adapter
        run: python -m pytest pydantic-ai-adapter/tests -q
```

- [ ] **Step 2: Verify the nested wheel contents**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pip wheel .\pydantic-ai-adapter --no-deps --wheel-dir .\pydantic-ai-adapter\dist
.\.venv-pydantic-ai\Scripts\python.exe -c "import zipfile, pathlib; p=next(pathlib.Path('pydantic-ai-adapter/dist').glob('*.whl')); print('\\n'.join(zipfile.ZipFile(p).namelist()))"
```

Expected: the wheel contains `tdai_pydantic_ai/__init__.py`,
`tdai_pydantic_ai/client.py`, `tdai_pydantic_ai/capability.py`, and metadata;
it does not contain tests or `.venv-pydantic-ai`.

Delete the single generated wheel by its explicit resolved path after
inspection, in accordance with the workspace deletion policy.

- [ ] **Step 3: Run the clean Python test suite**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pytest pydantic-ai-adapter/tests -q
```

Expected: all adapter tests PASS.

- [ ] **Step 4: Commit CI coverage**

```powershell
git add .github/workflows/pr-ci.yml
git commit -s -m "ci: test PydanticAI adapter"
```

---

### Task 6: Full Repository Verification and Submission Commit Audit

**Files:**

- Verify all modified files.
- Modify implementation files only when a verification failure identifies a
  concrete defect; add or adjust a failing regression test before each runtime
  correction.

**Interfaces:**

- Produces verification evidence and a clean, signed commit series.

- [ ] **Step 1: Install Node dependencies**

Run:

```powershell
npm install --ignore-scripts
```

Expected: dependencies install successfully. The ignored root `package-lock.json`
may be created locally but must not be staged.

- [ ] **Step 2: Run all Python adapter tests**

Run:

```powershell
.\.venv-pydantic-ai\Scripts\python.exe -m pytest pydantic-ai-adapter/tests -q
```

Expected: all tests PASS with no warnings from the adapter.

- [ ] **Step 3: Run the complete Node test suite**

Run:

```powershell
npm test
```

Expected: all Vitest tests PASS.

- [ ] **Step 4: Run the repository build**

Run:

```powershell
npm run build
```

Expected: all plugin and script builds exit with code 0.

- [ ] **Step 5: Verify both packages**

Run:

```powershell
npm pack --dry-run
.\.venv-pydantic-ai\Scripts\python.exe -m pip wheel .\pydantic-ai-adapter --no-deps --wheel-dir .\pydantic-ai-adapter\dist
```

Expected: npm pack stays below the repository size guard and the Python wheel
builds successfully.

Delete only the explicitly named generated Python wheel after inspecting it.
Do not perform a recursive or wildcard deletion.

- [ ] **Step 6: Check formatting, worktree scope, and DCO**

Run:

```powershell
git diff --check
git status --short
git diff --stat origin/main...HEAD
git log --format="%h %s%n%b" origin/main..HEAD
```

Expected:

- no whitespace errors;
- no virtual environment, cache, lockfile, wheel, or npm tarball is staged;
- changes are limited to the plan/spec, Python adapter, adapter docs, README
  links, `.gitignore`, and CI;
- every commit contains `Signed-off-by: Whosey <3038492002@qq.com>`.

- [ ] **Step 7: Review issue acceptance criteria**

Confirm from the final diff:

- architecture and data flow are documented;
- PydanticAI automatic recall and capture are implemented;
- both memory search tools are implemented;
- session end is implemented;
- authentication, timeout, errors, concurrency, and package installation are
  tested;
- no generic competing SDK or unrelated core change was added.

- [ ] **Step 8: Prepare the push**

Use branch `feat/pydantic-ai-adapter-235`. Before pushing, configure the user's
fork as a writable remote if it is not already present. Push with:

```powershell
git push -u <fork-remote> feat/pydantic-ai-adapter-235
```

The upstream `origin` remains `TencentCloud/TencentDB-Agent-Memory`; do not
attempt to push there unless the authenticated account has confirmed write
access.
