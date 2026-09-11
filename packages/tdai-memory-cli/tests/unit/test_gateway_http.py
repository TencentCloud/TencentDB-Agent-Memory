import http.client
import json
from unittest.mock import patch

from tdai_memory_cli.config import load_config
from tdai_memory_cli.gateway_http import request_json


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


def test_request_json_retries_remote_disconnect_once():
    calls = []
    config = load_config({"TDAI_GATEWAY_URL": "http://gateway.local"}, "/tmp/repo")

    def fake_urlopen(_request, timeout):
        calls.append(timeout)
        if len(calls) == 1:
            raise http.client.RemoteDisconnected("remote closed")
        return FakeResponse(json.dumps({"context": "ok"}).encode("utf-8"))

    with patch("urllib.request.urlopen", fake_urlopen):
        assert request_json(config, "/recall", body={"query": "q"}) == {"context": "ok"}

    assert len(calls) == 2
