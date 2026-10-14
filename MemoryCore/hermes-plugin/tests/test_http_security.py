"""Real HTTP regression checks for authenticated stdlib transports.

Run: python3 -m unittest discover -s MemoryCore/hermes-plugin/tests -v
Only ephemeral loopback servers and synthetic credentials are used.
"""
from __future__ import annotations

import contextlib
import http.server
import importlib.util
import json
import sys
import threading
import unittest
import urllib.error
from pathlib import Path

CORE = Path(__file__).resolve().parents[2]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


hermes = load_module("http_security_hermes", CORE / "hermes-plugin/memory/memory_tencentdb/client.py")
TOKEN = "synthetic-http-regression-token"
PRIVATE_BODY = "synthetic-memory-that-must-not-enter-logs"


@contextlib.contextmanager
def server(*, status=200, location=None, response=None, reason=None):
    requests = []
    payload = json.dumps(response or {"code": 0, "data": {"ok": True}}).encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        def handle_request(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            requests.append({"method": self.command, "authorization": self.headers.get("Authorization"), "body": body})
            self.send_response(status, reason)
            if location:
                self.send_header("Location", location)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = handle_request
        do_POST = handle_request

        def log_message(self, *args):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{srv.server_port}", requests
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=3)


class HttpSecurityTests(unittest.TestCase):
    def check_redirects(self, method):
        with server() as (destination, received):
            for status in (301, 302, 303, 307, 308):
                with self.subTest(method=method, status=status):
                    with server(status=status, location=destination + "/capture") as (source, original):
                        with self.assertRaises(urllib.error.HTTPError):
                            sdk = hermes.MemoryTencentdbSdkClient(source, api_key=TOKEN)
                            if method == "GET":
                                sdk.health()
                            else:
                                sdk._post("/v3/conversation/add", {"messages": [{"content": PRIVATE_BODY}]})
                        self.assertEqual(len(original), 1)
                        self.assertIn(TOKEN, original[0]["authorization"])
                        self.assertEqual(received, [], "redirect destination must receive neither credential nor body")

    def test_hermes_get_redirects_are_rejected(self):
        self.check_redirects("GET")

    def test_hermes_post_redirects_are_rejected(self):
        self.check_redirects("POST")

    def test_relative_same_origin_redirect_is_rejected(self):
        with server(status=302, location="/capture") as (url, received):
            sdk = hermes.MemoryTencentdbSdkClient(url, api_key=TOKEN)
            with self.assertRaises(urllib.error.HTTPError) as error:
                sdk.health()
            self.assertEqual(error.exception.code, 302)
            self.assertEqual(len(received), 1)

    def test_get_error_reason_is_not_logged_and_body_is_retained(self):
        with server(status=401, reason=PRIVATE_BODY, response={"message": PRIVATE_BODY}) as (url, _):
            sdk = hermes.MemoryTencentdbSdkClient(url, api_key=TOKEN)
            with self.assertLogs(hermes.logger, level="DEBUG") as logs:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    sdk.health()
            self.assertNotIn(PRIVATE_BODY, " ".join(logs.output))
            self.assertIn(PRIVATE_BODY, error.exception.read().decode())

    def test_hermes_direct_requests_work(self):
        with server() as (url, received):
            sdk = hermes.MemoryTencentdbSdkClient(url, api_key=TOKEN)
            self.assertTrue(sdk.health()["data"]["ok"])
            self.assertTrue(sdk._post("/v3/test", {"message": PRIVATE_BODY})["data"]["ok"])
            self.assertEqual([r["method"] for r in received], ["GET", "POST"])
            self.assertTrue(all(r["authorization"] == f"Bearer {TOKEN}" for r in received))
            self.assertEqual(json.loads(received[1]["body"])["message"], PRIVATE_BODY)

    def test_hermes_http_error_body_is_not_logged(self):
        with server(status=401, response={"message": PRIVATE_BODY}) as (url, _):
            sdk = hermes.MemoryTencentdbSdkClient(url, api_key=TOKEN)
            with self.assertLogs(hermes.logger, level="DEBUG") as logs:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    sdk._post("/v3/test", {})
            self.assertNotIn(PRIVATE_BODY, " ".join(logs.output))
            self.assertNotIn(TOKEN, " ".join(logs.output))
            self.assertIn(PRIVATE_BODY, error.exception.read().decode())

    def test_hermes_application_error_message_is_not_logged(self):
        with server(response={"code": 13, "message": PRIVATE_BODY}) as (url, _):
            sdk = hermes.MemoryTencentdbSdkClient(url, api_key=TOKEN)
            with self.assertLogs(hermes.logger, level="WARNING") as logs:
                result = sdk._post("/v3/test", {})
            self.assertEqual(result["message"], PRIVATE_BODY)
            self.assertNotIn(PRIVATE_BODY, " ".join(logs.output))
            self.assertNotIn(TOKEN, " ".join(logs.output))


if __name__ == "__main__":
    unittest.main()
