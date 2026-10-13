"""Two real HTTPS origins; injected clients must not weaken redirect policy."""
import asyncio
import json
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
from tencentdb_agent_memory import _http, _v3_http


class RedirectSecurityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix="sdk-redirect-")
        cert = str(Path(cls.tmp.name) / "cert.pem")
        key = str(Path(cls.tmp.name) / "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-days", "1", "-keyout", key, "-out", cert,
                        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.ca = ssl.create_default_context(cafile=cert)
        cls.hits = []
        cls.origin_hits = []
        cls.status = 200

        class Handler(BaseHTTPRequestHandler):
            def handle_request(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.server.destination:
                    cls.hits.append((dict(self.headers), body))
                else:
                    cls.origin_hits.append((dict(self.headers), body))
                status = 200 if self.server.destination else cls.status
                if isinstance(status, list):
                    status = status.pop(0)
                data = json.dumps(getattr(cls, "response", {"code": 0, "data": {"synthetic": True}})).encode()
                self.send_response(status)
                if status != 200:
                    self.send_header("Location", cls.destination + "/sink")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            do_POST = handle_request
            do_GET = handle_request
            def log_message(self, *_):
                pass

        cls.servers = []
        cls.threads = []
        for destination in (True, False):
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            server.destination = destination
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.servers.append(server)
            cls.threads.append(thread)
        cls.destination = f"https://localhost:{cls.servers[0].server_port}"
        cls.endpoint = f"https://localhost:{cls.servers[1].server_port}"

    @classmethod
    def tearDownClass(cls):
        for server, thread in zip(cls.servers, cls.threads):
            server.shutdown()
            server.server_close()
            thread.join()
        cls.tmp.cleanup()

    def exercise(self, module, asynchronous, method, status):
        type(self).status = status
        self.hits.clear()
        self.origin_hits.clear()
        kwargs = dict(verify=self.ca, follow_redirects=True, trust_env=False, timeout=2)
        def verify_call(call):
            if status == 200:
                self.assertEqual(call(), {"synthetic": True})
            else:
                with self.assertRaises(httpx.HTTPStatusError):
                    call()
        if asynchronous:
            async def run():
                async with httpx.AsyncClient(**kwargs) as client:
                    stub = module.AsyncHttpStub(self.endpoint, "synthetic-bearer", "synthetic-service",
                                               user_key="synthetic-user-key", client=client)
                    if status == 200:
                        result = await getattr(stub, method)("/source", {"content": "private-canary"})
                        self.assertEqual(result, {"synthetic": True})
                    else:
                        with self.assertRaises(httpx.HTTPStatusError):
                            await getattr(stub, method)("/source", {"content": "private-canary"})
            asyncio.run(run())
        else:
            with httpx.Client(**kwargs) as client:
                stub = module.HttpStub(self.endpoint, "synthetic-bearer", "synthetic-service",
                                       user_key="synthetic-user-key", client=client)
                verify_call(lambda: getattr(stub, method)("/source", {"content": "private-canary"}))
        self.assertEqual(len(self.origin_hits), 1)
        self.assertEqual(self.origin_hits[0][0]["Authorization"], "Bearer synthetic-bearer")
        self.assertEqual(self.hits, [], "A redirect must never forward credentials, query or content")


for name, module, asynchronous, method in (
    ("v2_sync_post", _http, False, "post"),
    ("v2_async_post", _http, True, "post"),
    ("v3_sync_post", _v3_http, False, "post"),
    ("v3_async_post", _v3_http, True, "post"),
    ("v3_sync_get", _v3_http, False, "get"),
    ("v3_async_get", _v3_http, True, "get"),
):
    for status in (200, 301, 302, 303, 307, 308):
        def test(self, module=module, asynchronous=asynchronous, method=method, status=status):
            self.exercise(module, asynchronous, method, status)
        setattr(RedirectSecurityTest, f"test_{name}_{status}", test)
