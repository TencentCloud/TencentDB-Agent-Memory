"""Real HTTPS regression tests using local, synthetic keys and memory content."""
import asyncio
import json
import logging
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import httpx
from tencentdb_agent_memory import _http, _v3_http
from tencentdb_agent_memory.v2.client import MemoryClient, AsyncMemoryClient


class TransportSecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="memory-sdk-tls-")
        cls.cert = str(Path(cls.tmp.name) / "cert.pem")
        key = str(Path(cls.tmp.name) / "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-days", "1", "-keyout", key, "-out", cls.cert,
                        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                cls.requests.append((self.headers.get("Authorization"),
                                     self.headers.get("x-tdai-service-id"), json.loads(body)))
                data = json.dumps({"code": 0, "data": {"synthetic": "private-response-canary"}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def log_message(self, *_args):
                pass
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = "https://localhost:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.tmp.cleanup()

    def test_public_sync_client_rejects_untrusted_tls_by_default(self):
        client = MemoryClient(self.endpoint, "synthetic-key", "synthetic-service", timeout=2)
        before = len(self.requests)
        try:
            with self.assertRaises(httpx.ConnectError):
                client.add_conversation("synthetic-session", [])
            self.assertEqual(len(self.requests), before)
        finally:
            client.close()

    def test_public_async_client_rejects_untrusted_tls_by_default(self):
        async def run():
            client = AsyncMemoryClient(self.endpoint, "synthetic-key", "synthetic-service", timeout=2)
            before = len(self.requests)
            try:
                with self.assertRaises(httpx.ConnectError):
                    await client.add_conversation("synthetic-session", [])
                self.assertEqual(len(self.requests), before)
            finally:
                await client.close()
        asyncio.run(run())

    def test_sync_transports_trust_hostname_authentication_and_private_logs(self):
        for module in (_http, _v3_http):
            with self.subTest(transport=module.__name__):
                client = httpx.Client(verify=ssl.create_default_context(cafile=self.cert), trust_env=False)
                stub = module.HttpStub(self.endpoint, "synthetic-key", "synthetic-service", client=client)
                try:
                    with self.assertLogs(module.logger, logging.DEBUG) as logs:
                        result = stub.post("/synthetic", {"content": "private-request-canary"})
                    self.assertEqual(result, {"synthetic": "private-response-canary"})
                    self.assertEqual(self.requests[-1][:2], ("Bearer synthetic-key", "synthetic-service"))
                    self.assertNotIn("private-request-canary", str(logs.output))
                    self.assertNotIn("private-response-canary", str(logs.output))
                    self.assertNotIn("synthetic-key", str(logs.output))
                    stub.endpoint = self.endpoint.replace("localhost", "127.0.0.1")
                    before = len(self.requests)
                    with self.assertRaises(httpx.ConnectError):
                        stub.post("/synthetic", {})
                    self.assertEqual(len(self.requests), before)
                finally:
                    stub.close()

    def test_async_transports_trust_hostname_authentication_and_private_logs(self):
        async def run(module):
            client = httpx.AsyncClient(verify=ssl.create_default_context(cafile=self.cert), trust_env=False)
            stub = module.AsyncHttpStub(self.endpoint, "synthetic-key", "synthetic-service", client=client)
            try:
                with self.assertLogs(module.logger, logging.DEBUG) as logs:
                    result = await stub.post("/synthetic", {"content": "private-request-canary"})
                self.assertEqual(result, {"synthetic": "private-response-canary"})
                self.assertEqual(self.requests[-1][:2], ("Bearer synthetic-key", "synthetic-service"))
                self.assertNotIn("private-request-canary", str(logs.output))
                self.assertNotIn("private-response-canary", str(logs.output))
                self.assertNotIn("synthetic-key", str(logs.output))
                stub.endpoint = self.endpoint.replace("localhost", "127.0.0.1")
                before = len(self.requests)
                with self.assertRaises(httpx.ConnectError):
                    await stub.post("/synthetic", {})
                self.assertEqual(len(self.requests), before)
            finally:
                await stub.close()
        for module in (_http, _v3_http):
            with self.subTest(transport=module.__name__):
                asyncio.run(run(module))

    def test_explicit_insecure_mode_does_not_change_subsequent_defaults(self):
        insecure = MemoryClient(self.endpoint, "synthetic-key", "synthetic-service", verify=False)
        try:
            self.assertEqual(insecure.add_conversation("synthetic-session", []),
                             {"synthetic": "private-response-canary"})
            self.test_public_sync_client_rejects_untrusted_tls_by_default()
        finally:
            insecure.close()


if __name__ == "__main__":
    unittest.main()
