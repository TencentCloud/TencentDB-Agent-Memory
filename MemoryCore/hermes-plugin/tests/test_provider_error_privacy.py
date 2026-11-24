"""Provider boundaries with real HTTP and a minimal host-interface stand-in.

This does not load an installed Hermes host or start a Gateway.
"""
import contextlib
import http.server
import importlib.util
import json
from pathlib import Path
import sys
import threading
import types
import unittest

ROOT = Path(__file__).resolve().parents[1] / "memory/memory_tencentdb"
# Only the external base interface is replaced. Load all provider/client code.
agent = types.ModuleType("agent")
agent.__path__ = []
interface = types.ModuleType("agent.memory_provider")
interface.MemoryProvider = type("MemoryProvider", (), {})
saved = {name: sys.modules.get(name) for name in ("agent", "agent.memory_provider")}
sys.modules["agent"] = agent
sys.modules["agent.memory_provider"] = interface
try:
    spec = importlib.util.spec_from_file_location("privacy_provider", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    provider = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = provider
    spec.loader.exec_module(provider)
finally:
    for name, old in saved.items():
        if old is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = old

PRIVATE = "synthetic-backend-private-reason"
TOKEN = "synthetic-provider-credential"

@contextlib.contextmanager
def failing_backend():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            # Isolate the provider's HTTPError.reason boundary. Upstream client
            # body logging is a separate defect covered by the transport PR.
            body = json.dumps({"message": "synthetic generic backend error"}).encode()
            self.send_response(401, PRIVATE)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)

class ProviderErrorPrivacyTests(unittest.TestCase):
    def instance(self, url="http://127.0.0.1:9"):
        instance = provider.MemoryTencentdbProvider()
        instance._client = provider.MemoryTencentdbSdkClient(url, api_key=TOKEN, timeout=1)
        instance._gateway_available = True
        instance._initialized = True
        instance._ensure_alive_for_request = lambda: True
        instance._try_recover_gateway = lambda **kwargs: False
        return instance

    def check_safe(self, text):
        for value in (PRIVATE, TOKEN):
            self.assertNotIn(value, text)
        self.assertIn("HTTPError", text)

    def test_prefetch_parallel_http_failures_do_not_log_remote_reasons(self):
        with failing_backend() as url:
            instance = self.instance(url)
            with self.assertLogs(provider.logger, level="DEBUG") as captured:
                self.assertEqual(instance.prefetch("synthetic recall"), "")
            self.check_safe("\n".join(captured.output))

    def test_background_sync_http_failure_logs_class_and_keeps_failure_accounting(self):
        with failing_backend() as url:
            instance = self.instance(url)
            with self.assertLogs(provider.logger, level="DEBUG") as captured:
                instance.sync_turn("synthetic user", "synthetic reply")
                for thread in instance._active_syncs:
                    thread.join(timeout=3)
                    self.assertFalse(thread.is_alive())
            self.check_safe("\n".join(captured.output))
            self.assertEqual(instance._consecutive_failures, 1)

    def test_tool_error_reply_omits_remote_reason(self):
        with failing_backend() as url:
            instance = self.instance(url)
            result = instance.handle_tool_call("memory_tencentdb_memory_search", {"query": "synthetic query"})
            self.assertIn("error", json.loads(result))
            self.check_safe(result)
            self.assertEqual(instance._consecutive_failures, 1)

    def test_parallel_error_collection_does_not_evaluate_exception_strings(self):
        calls = []
        class HostileError(Exception):
            def __str__(self):
                calls.append(True)
                return PRIVATE
        def fail(**kwargs):
            raise HostileError()
        instance = self.instance()
        instance._client.atomic_search = fail
        instance._client.core_read = fail
        instance._client.scenario_ls = fail
        with self.assertLogs(provider.logger, level="DEBUG") as captured:
            self.assertEqual(instance.prefetch("synthetic query"), "")
        self.assertEqual(calls, [])
        self.assertIn("HostileError", "\n".join(captured.output))

    def test_recovery_failures_do_not_log_exception_contents_or_leave_recovery_locked(self):
        class Supervisor:
            def is_running(self):
                return False
            def ensure_running(self):
                raise RuntimeError(PRIVATE)
        instance = provider.MemoryTencentdbProvider()
        instance._supervisor = Supervisor()
        with self.assertLogs(provider.logger, level="DEBUG") as captured:
            self.assertFalse(instance._try_recover_gateway(bypass_cooldown=True))
            self.assertFalse(instance._try_recover_gateway(bypass_cooldown=True))
        self.assertNotIn(PRIVATE, "\n".join(captured.output))
        self.assertIn("RuntimeError", "\n".join(captured.output))

    def test_shutdown_failure_keeps_cleanup_without_logging_exception_contents(self):
        class Supervisor:
            def shutdown(self):
                raise RuntimeError(PRIVATE)
        instance = self.instance()
        instance._supervisor = Supervisor()
        with self.assertLogs(provider.logger, level="DEBUG") as captured:
            instance.shutdown()
        self.assertNotIn(PRIVATE, "\n".join(captured.output))
        self.assertIn("RuntimeError", "\n".join(captured.output))
        self.assertIsNone(instance._client)
        self.assertFalse(instance._initialized)

if __name__ == "__main__":
    unittest.main()
