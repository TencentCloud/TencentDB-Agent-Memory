import http.client
import json
from unittest.mock import patch

from tdai_memory_mcp.client import GatewayClient


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


def test_client_retries_remote_disconnect_once():
    calls = []

    def fake_urlopen(_request, timeout):
        calls.append(timeout)
        if len(calls) == 1:
            raise http.client.RemoteDisconnected("remote closed")
        return FakeResponse(json.dumps({"status": "ok"}).encode("utf-8"))

    client = GatewayClient("http://gateway.local", timeout_ms=1000)
    with patch("urllib.request.urlopen", fake_urlopen):
        assert client.health() == {"status": "ok"}

    assert len(calls) == 2
