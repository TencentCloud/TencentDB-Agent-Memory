"""SDK -> production transport -> httpx -> real loopback HTTP.

The server is a protocol fixture, not an emulation of Core authorization.
No HTTP client or transport methods are mocked.
"""
import asyncio
import json
import socket
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import httpx
import pytest

from tencentdb_agent_memory._v3_http import AsyncHttpStub, HttpStub
from tencentdb_agent_memory.errors import TDAMError
from tencentdb_agent_memory.v3.client import AsyncMemoryClient, MemoryClient

pytestmark = pytest.mark.integration


@pytest.fixture
def server():
    state = SimpleNamespace(
        requests=[], status=200, data=b'{"code":0,"data":{"total":7}}',
        mode="normal", release=threading.Event(),
    )

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state.requests.append({"path": self.path, "headers": self.headers, "body": body})
            if state.mode == "disconnect":
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send_response(state.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(state.data)))
            self.send_header("x-trace-id", "loopback-trace")
            self.end_headers()
            try:
                if state.mode == "partial-body":
                    self.wfile.write(state.data[:1])
                    self.wfile.flush()
                    state.release.wait(3)
                    self.wfile.write(state.data[1:])
                else:
                    self.wfile.write(state.data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # The timeout/disconnect test intentionally closes the client.

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    state.endpoint = f"http://127.0.0.1:{httpd.server_port}"
    try:
        yield state
    finally:
        state.release.set()
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=3)
        assert not thread.is_alive()


@pytest.fixture(params=[False, True], ids=["sync", "async"])
def execute(request, server):
    def call(*, concurrent=False, timeout=2):
        options = dict(endpoint=server.endpoint, api_key="test-api-key", service_id="tenant", user_key="test-user-key")
        isolation = dict(team_id="team", agent_id="agent", user_id="user", session_id="bound")
        if request.param:
            async def run():
                async with httpx.AsyncClient(timeout=timeout, trust_env=False) as http:
                    client = AsyncMemoryClient(stub=AsyncHttpStub(**options, client=http), **isolation)
                    if concurrent:
                        return await asyncio.gather(*[
                            client.with_isolation(user_id=f"user-{i}", session_id=f"session-{i}").query_conversation(limit=0)
                            for i in range(4)
                        ])
                    return await client.query_conversation(limit=0)
            return asyncio.run(run())
        with httpx.Client(timeout=timeout, trust_env=False) as http:
            client = MemoryClient(stub=HttpStub(**options, client=http), **isolation)
            if concurrent:
                with ThreadPoolExecutor(max_workers=4) as executor:
                    return list(executor.map(
                        lambda i: client.with_isolation(user_id=f"user-{i}", session_id=f"session-{i}").query_conversation(limit=0),
                        range(4),
                    ))
            return client.query_conversation(limit=0)
    return call


def test_real_request_preserves_isolation_credentials_and_trace(server, execute):
    assert execute() == {"total": 7, "trace_id": "loopback-trace"}
    request = server.requests[0]
    assert request["path"] == "/v3/conversation/query"
    assert request["body"] == {"team_id": "team", "agent_id": "agent", "user_id": "user", "session_id": "bound", "limit": 0}
    assert request["headers"]["Authorization"] == "Bearer test-api-key"
    assert request["headers"]["x-tdai-service-id"] == "tenant"
    assert request["headers"]["x-tdai-user-key"] == "test-user-key"


def test_concurrent_clones_keep_separate_request_contexts(server, execute):
    assert execute(concurrent=True) == [{"total": 7, "trace_id": "loopback-trace"}] * 4
    assert sorted((req["body"]["user_id"], req["body"]["session_id"]) for req in server.requests) == [
        (f"user-{i}", f"session-{i}") for i in range(4)
    ]


def test_http_and_business_error_details_survive_real_serialization(server, execute):
    server.status = 409
    server.data = json.dumps({"code": 40901, "message": "stale", "data": {"current_version": 4}}).encode()
    with pytest.raises(TDAMError) as caught:
        execute()
    assert caught.value.code == 40901
    assert caught.value.details == {"current_version": 4}
    assert caught.value.request_id == "loopback-trace"


def test_non_json_gateway_error_uses_http_status(server, execute):
    server.status = 502
    server.data = b"upstream unavailable"
    with pytest.raises(TDAMError) as caught:
        execute()
    assert caught.value.code == 502
    assert caught.value.request_id == "loopback-trace"


def test_response_body_stall_is_a_read_timeout(server, execute):
    server.mode = "partial-body"
    with pytest.raises(httpx.ReadTimeout):
        execute(timeout=0.1)
    assert len(server.requests) == 1


def test_disconnected_peer_is_a_transport_error(server, execute):
    server.mode = "disconnect"
    with pytest.raises(httpx.RemoteProtocolError):
        execute()
    assert len(server.requests) == 1
