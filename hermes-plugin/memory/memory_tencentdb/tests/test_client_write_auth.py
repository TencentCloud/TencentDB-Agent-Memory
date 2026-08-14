import json
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

CLIENT_PATH = Path(__file__).parents[1] / "client.py"
SPEC = importlib.util.spec_from_file_location("memory_tencentdb_client", CLIENT_PATH)
assert SPEC and SPEC.loader
CLIENT_MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CLIENT_MODULE)
MemoryTencentdbSdkClient = CLIENT_MODULE.MemoryTencentdbSdkClient


class _Response:
    def __init__(self, body):
        self._body = json.dumps(body).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._body


class ClientWriteAuthTest(unittest.TestCase):
    def test_capture_discovers_and_sends_loopback_token(self):
        with tempfile.TemporaryDirectory() as root:
            token_path = Path(root) / "gateway.token"
            token_path.write_text("test-loopback-token\n", encoding="utf-8")
            requests = []

            def answer(request, **_kwargs):
                requests.append(request)
                if request.full_url.endswith("/memory/info"):
                    return _Response({"tokenPath": str(token_path)})
                return _Response({"l0_recorded": 1})

            client = MemoryTencentdbSdkClient("http://127.0.0.1:8420")
            with patch("urllib.request.urlopen", side_effect=answer):
                client.capture("user", "assistant", "session")

            self.assertEqual(len(requests), 2)
            self.assertEqual(
                requests[1].headers.get("X-memory-token"),
                "test-loopback-token",
            )


if __name__ == "__main__":
    unittest.main()
