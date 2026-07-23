from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from agent_framework import AgentResponse, AgentSession, Message, SessionContext

from tencentdb_agent_memory_agent_framework import (
    GatewayError, TencentDBMemoryContextProvider, TencentDBMemoryGatewayClient,
)


@pytest.fixture
def gateway():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_GET(self):
            requests.append((self.command, self.path, None, dict(self.headers)))
            self._send({"status": "ok"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            requests.append((self.command, self.path, payload, dict(self.headers)))
            responses = {
                "/recall": {"context": "User prefers concise answers.", "memory_count": 1},
                "/capture": {"l0_recorded": 2, "scheduler_notified": True},
                "/search/memories": {"results": "L1 result", "total": 1},
                "/search/conversations": {"results": "L0 result", "total": 1},
                "/session/end": {"flushed": True},
            }
            self._send(responses[self.path])

        def _send(self, payload):
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}", requests
    server.shutdown()
    thread.join()
    server.server_close()


def make_context(user_text="Please remember this."):
    return SessionContext(
        session_id="session-123", input_messages=[Message("user", [user_text])]
    )


@pytest.mark.asyncio
async def test_provider_recall_capture_search_and_flush(gateway):
    url, requests = gateway
    client = TencentDBMemoryGatewayClient(base_url=url, api_key="secret")
    provider = TencentDBMemoryContextProvider(
        client=client, user_id="user-7", max_context_chars=100
    )
    session = AgentSession(session_id="session-123")
    context = make_context()
    state = {}

    await provider.before_run(agent=object(), session=session, context=context, state=state)
    assert "User prefers concise answers." in context.instructions[0]
    assert "untrusted context" in context.instructions[0]
    assert state["last_recall_count"] == 1
    assert requests[0][2]["session_key"] == "agent-framework:session-123"
    assert requests[0][3]["Authorization"] == "Bearer secret"

    context._response = AgentResponse(
        messages=[Message("assistant", ["I will remember that."])]
    )
    await provider.after_run(agent=object(), session=session, context=context, state=state)
    capture = requests[1][2]
    assert capture["user_content"] == "Please remember this."
    assert capture["assistant_content"] == "I will remember that."
    assert capture["session_id"] == "session-123"
    assert capture["user_id"] == "user-7"
    assert capture["messages"] == [
        {"role": "user", "content": "Please remember this."},
        {"role": "assistant", "content": "I will remember that."},
    ]
    assert state["last_capture_count"] == 2

    assert await provider.search_memories("preference") == "L1 result"
    assert await provider.search_conversations("remember", session=session) == "L0 result"
    await provider.end_session(session)
    assert requests[-1][1] == "/session/end"
    assert requests[-1][2]["session_key"] == "agent-framework:session-123"


@pytest.mark.asyncio
async def test_provider_skips_empty_turns(gateway):
    url, requests = gateway
    provider = TencentDBMemoryContextProvider(
        client=TencentDBMemoryGatewayClient(base_url=url)
    )
    session = AgentSession(session_id="empty")
    context = make_context("")
    await provider.before_run(agent=object(), session=session, context=context, state={})
    await provider.after_run(agent=object(), session=session, context=context, state={})
    assert requests == []


@pytest.mark.asyncio
async def test_fail_open_and_strict_modes():
    client = TencentDBMemoryGatewayClient(base_url="http://127.0.0.1:1", timeout=0.1)
    session = AgentSession(session_id="unavailable")
    fail_open = TencentDBMemoryContextProvider(client=client)
    await fail_open.before_run(
        agent=object(), session=session, context=make_context(), state={}
    )
    strict = TencentDBMemoryContextProvider(client=client, strict=True)
    with pytest.raises(GatewayError):
        await strict.before_run(
            agent=object(), session=session, context=make_context(), state={}
        )


@pytest.mark.parametrize("url", [
    "ftp://127.0.0.1:8420",
    "http://user:secret@127.0.0.1:8420",
    "http://127.0.0.1:8420?token=secret",
    "https://memory.example.com",
])
def test_client_rejects_unsafe_urls(url):
    with pytest.raises(ValueError):
        TencentDBMemoryGatewayClient(base_url=url)


def test_remote_gateway_requires_explicit_opt_in():
    client = TencentDBMemoryGatewayClient(
        base_url="https://memory.example.com", allow_remote=True
    )
    assert client.base_url == "https://memory.example.com"
