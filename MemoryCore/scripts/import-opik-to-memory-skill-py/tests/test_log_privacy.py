"""Synthetic end-to-end importer error/progress logging regressions (stdlib only)."""
import contextlib
import http.server
import importlib.util
import json
from pathlib import Path
import sys
import threading
import unittest

spec = importlib.util.spec_from_file_location("log_privacy_importer", Path(__file__).resolve().parents[1] / "import_opik.py")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
PRIVATE = "synthetic-private-response-value"
TOKEN = "synthetic-secret-api-key"

@contextlib.contextmanager
def server(*, status=200, response=None, reason=None):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            body = json.dumps(response).encode()
            self.send_response(status, reason)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:" + str(srv.server_port)
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=3)

class Logs:
    def __init__(self):
        self.messages = []
    def info(self, message):
        self.messages.append(message)
    warning = info

class LogPrivacyTests(unittest.TestCase):
    def client(self, url):
        return module.MemoryCoreClient(url, TOKEN, "synthetic-service", "synthetic-team", "synthetic-agent", "synthetic-user", retries=0)
    def session(self):
        return module.Session("synthetic-session", "synthetic-thread", "synthetic-trace", 1, [{"role": "user", "content": "synthetic message"}])
    def run_import(self, core, force=False):
        logs = Logs()
        stats = module.import_session(self.session(), core, turn_gap_s=0, force_archive=force, dry_run=False, logger=logs)
        return stats, "\n".join(logs.messages)
    def test_application_error_does_not_copy_response_fields_to_exception_or_logs(self):
        with server(response={"code": PRIVATE, "message": TOKEN, "request_id": PRIVATE}) as url:
            with self.assertRaises(RuntimeError) as error:
                self.client(url).conversation_add("synthetic-session", [])
            for forbidden in (PRIVATE, TOKEN):
                self.assertNotIn(forbidden, str(error.exception))
            stats, logs = self.run_import(self.client(url))
            self.assertEqual(stats["errors"], 1)
            for forbidden in (PRIVATE, TOKEN):
                self.assertNotIn(forbidden, logs)
    def test_http_reason_and_body_remain_out_of_default_exception_and_logs(self):
        with server(status=401, reason=PRIVATE, response={"secret": TOKEN}) as url:
            with self.assertRaises(module.HttpError) as error:
                module.http_request("POST", url, json_body={}, retries=0)
            self.assertIn(TOKEN, error.exception.body)  # explicitly inspected diagnostics remain available
            self.assertEqual(error.exception.message, PRIVATE)
            self.assertNotIn(PRIVATE, str(error.exception))
            self.assertNotIn(TOKEN, str(error.exception))
            stats, logs = self.run_import(self.client(url))
            self.assertEqual(stats["errors"], 1)
            self.assertNotIn(PRIVATE, logs)
            self.assertNotIn(TOKEN, logs)
    def test_force_archive_failure_does_not_stringify_arbitrary_exception(self):
        class HostileError(Exception):
            def __str__(self):
                raise AssertionError("Exception string must not be evaluated")
        class Core:
            def conversation_add(self, *args):
                return {"status": "buffered"}
            def force_archive(self, *args):
                raise HostileError()
        stats, logs = self.run_import(Core(), force=True)
        self.assertEqual(stats["errors"], 1)
        self.assertIn("HostileError", logs)
    def test_success_progress_omits_remote_task_ids_and_unrecognized_status_values(self):
        for data in ({"status": "archived", "archived": {"task_id": PRIVATE}}, {"status": PRIVATE}):
            with self.subTest(data=data), server(response={"code": 0, "data": data}) as url:
                stats, logs = self.run_import(self.client(url), force=True)
                self.assertEqual(stats["errors"], 0)
                self.assertNotIn(PRIVATE, logs)
                self.assertNotIn(TOKEN, logs)

if __name__ == "__main__":
    unittest.main()
