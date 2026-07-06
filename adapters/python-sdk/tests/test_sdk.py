"""Tests for the Python SDK base classes and HTTP client."""

from __future__ import annotations

import json
import sys
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from base import TdaiAdapter, RecallResult, CaptureResult, SearchResult, HealthStatus
from client import TdaiHttpClient
from registry import TdaiAdapterRegistry
from errors import TdaiError, TdaiConnectionError, TdaiAuthError


class MockGateway(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok", "version": "0.3.6", "uptime": 100, "stores": {"vectorStore": True, "embeddingService": True}})
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if self.path == "/recall":
            self._respond(200, {"context": "Memory for: %s" % body.get("query", ""), "strategy": "hybrid", "memory_count": 3})
        elif self.path == "/capture":
            self._respond(200, {"l0_recorded": 2, "scheduler_notified": True})
        elif self.path == "/search/memories":
            self._respond(200, {"results": "found memories", "total": 5, "strategy": "embedding"})
        elif self.path == "/search/conversations":
            self._respond(200, {"results": "found conversations", "total": 10})
        elif self.path == "/session/end":
            self._respond(200, {"flushed": True})
        else:
            self._respond(404, {"error": "not found"})

    def _respond(self, code, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


_server = None
_thread = None


def setup_mock_server():
    global _server, _thread
    _server = HTTPServer(("127.0.0.1", 0), MockGateway)
    _thread = threading.Thread(target=_server.serve_forever, daemon=True)
    _thread.start()
    return "http://127.0.0.1:%d" % _server.server_address[1]


def teardown_mock_server():
    global _server
    if _server:
        _server.shutdown()
        _server = None


def test_adapter_abc_cannot_instantiate():
    try:
        TdaiAdapter()
        assert False, "Should not instantiate ABC"
    except TypeError:
        pass


def test_http_client_health():
    url = setup_mock_server()
    try:
        client = TdaiHttpClient(gateway_url=url)
        result = client.health()
        assert result.status == "ok"
        assert result.version == "0.3.6"
        assert result.uptime == 100
    finally:
        teardown_mock_server()


def test_http_client_recall():
    url = setup_mock_server()
    try:
        client = TdaiHttpClient(gateway_url=url)
        result = client.recall("hello world", "session-1")
        assert "hello world" in result.context
        assert result.strategy == "hybrid"
        assert result.memory_count == 3
    finally:
        teardown_mock_server()


def test_http_client_capture():
    url = setup_mock_server()
    try:
        client = TdaiHttpClient(gateway_url=url)
        result = client.capture("user msg", "assistant msg", "session-1")
        assert result.l0_recorded == 2
        assert result.scheduler_notified is True
    finally:
        teardown_mock_server()


def test_http_client_search_memories():
    url = setup_mock_server()
    try:
        client = TdaiHttpClient(gateway_url=url)
        result = client.search_memories("test query")
        assert result.total == 5
        assert result.strategy == "embedding"
    finally:
        teardown_mock_server()


def test_http_client_search_conversations():
    url = setup_mock_server()
    try:
        client = TdaiHttpClient(gateway_url=url)
        result = client.search_conversations("test query")
        assert result.total == 10
    finally:
        teardown_mock_server()


def test_http_client_end_session():
    url = setup_mock_server()
    try:
        client = TdaiHttpClient(gateway_url=url)
        result = client.end_session("session-1")
        assert result is True
    finally:
        teardown_mock_server()


def test_http_client_connection_error():
    client = TdaiHttpClient(gateway_url="http://127.0.0.1:19999", max_retries=1)
    try:
        client.health()
        assert False, "Should raise"
    except TdaiConnectionError:
        pass


def test_registry():
    url = setup_mock_server()
    try:
        registry = TdaiAdapterRegistry()
        client = TdaiHttpClient(gateway_url=url)
        registry.register("test", client)
        assert registry.list() == ["test"]
        assert registry.get("test") is client
        health = registry.health_all()
        assert health["test"].status == "ok"
        registry.unregister("test")
        assert registry.list() == []
    finally:
        teardown_mock_server()


def test_registry_destroy():
    registry = TdaiAdapterRegistry()
    client = TdaiHttpClient(gateway_url="http://localhost:1")
    registry.register("c1", client)
    registry.destroy_all()
    assert registry.list() == []


if __name__ == "__main__":
    tests = [
        test_adapter_abc_cannot_instantiate,
        test_http_client_health,
        test_http_client_recall,
        test_http_client_capture,
        test_http_client_search_memories,
        test_http_client_search_conversations,
        test_http_client_end_session,
        test_http_client_connection_error,
        test_registry,
        test_registry_destroy,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print("  PASS: %s" % t.__name__)
            passed += 1
        except Exception as e:
            print("  FAIL: %s: %s" % (t.__name__, e))
            failed += 1
    print("\n%d passed, %d failed, %d total" % (passed, failed, passed + failed))
    sys.exit(0 if failed == 0 else 1)
