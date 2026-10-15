"""Actual HTTP200 error envelopes must not become successful provider results."""
import contextlib
import http.server
import json
import threading
import unittest
from test_recall_accounting import provider

FORGED = 'synthetic-error-data-must-not-be-recalled'
TOKEN = 'synthetic-application-test-key'

@contextlib.contextmanager
def backend(response):
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append((self.path, body, self.headers.get('Authorization')))
            encoded = json.dumps(response(self.path)).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        def log_message(self, *args):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield 'http://127.0.0.1:' + str(server.server_port), requests
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)


def rejected(code=503):
    return {'code': code, 'message': 'generic backend rejection', 'data': {'items': [{'type': 'persona', 'content': FORGED}], 'content': FORGED, 'entries': [{'path': FORGED}]}}

class ApplicationFailureTests(unittest.TestCase):
    def instance(self, url):
        instance = provider.MemoryTencentdbProvider()
        instance._gateway_available = True
        instance._initialized = True
        instance._client = provider.MemoryTencentdbSdkClient(url, api_key=TOKEN, timeout=1)
        self.recovery_calls = []
        instance._try_recover_gateway = lambda **kwargs: self.recovery_calls.append(True)
        return instance

    def assert_rejected_data_absent(self, text):
        for value in (FORGED, TOKEN):
            self.assertNotIn(value, text)

    def test_rejected_recall_never_renders_error_data_and_counts_failure(self):
        with backend(lambda path: rejected()) as (url, requests):
            instance = self.instance(url)
            with self.assertLogs(provider.logger, level='DEBUG') as captured:
                result = instance.prefetch('synthetic query')
            self.assertEqual(result, '')
            self.assertEqual(instance._consecutive_failures, 1)
            self.assertEqual(len(requests), 3)
            self.assertEqual(self.recovery_calls, [])
            self.assert_rejected_data_absent('\n'.join(captured.output))

    def test_rejected_tool_calls_return_static_errors_instead_of_false_memories(self):
        with backend(lambda path: rejected()) as (url, requests):
            for tool, args in [('memory_tencentdb_memory_search', {'query': 'synthetic query'}), ('memory_tencentdb_conversation_search', {'query': 'synthetic query'}), ('memory_tencentdb_read_scene', {'scene_id': 'synthetic'})]:
                with self.subTest(tool=tool):
                    instance = self.instance(url)
                    result = instance.handle_tool_call(tool, args)
                    self.assert_rejected_data_absent(result)
                    self.assertIn('error', json.loads(result))
                    self.assertEqual(instance._consecutive_failures, 1)
                    self.assertEqual(self.recovery_calls, [])

    def test_rejected_capture_is_failure_without_gateway_relaunch(self):
        with backend(lambda path: rejected()) as (url, requests):
            instance = self.instance(url)
            with self.assertLogs(provider.logger, level='DEBUG') as captured:
                instance.sync_turn('synthetic user', 'synthetic assistant')
                for thread in instance._active_syncs:
                    thread.join(timeout=3); self.assertFalse(thread.is_alive())
            self.assertEqual(instance._consecutive_failures, 1)
            self.assertEqual(self.recovery_calls, [])
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0][2], 'Bearer ' + TOKEN)
            self.assertEqual(len(requests[0][1]['messages']), 2)
            self.assert_rejected_data_absent('\n'.join(captured.output))

    def test_successful_capture_preserves_request_and_resets_failures(self):
        with backend(lambda path: {'code': 0, 'data': {'captured': 2}}) as (url, requests):
            instance = self.instance(url); instance._consecutive_failures = 2
            instance.sync_turn('synthetic user', 'synthetic assistant')
            for thread in instance._active_syncs:
                thread.join(timeout=3); self.assertFalse(thread.is_alive())
            self.assertEqual(instance._consecutive_failures, 0)
            self.assertEqual(self.recovery_calls, [])
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0][2], 'Bearer ' + TOKEN)
            self.assertEqual([m['role'] for m in requests[0][1]['messages']], ['user', 'assistant'])
            self.assertEqual([m['content'] for m in requests[0][1]['messages']], ['synthetic user', 'synthetic assistant'])

    def test_nonnumeric_or_missing_success_code_is_not_accepted(self):
        for code in [False, '0', None, 'missing']:
            with self.subTest(code=code):
                response = rejected(code)
                if code == 'missing': response.pop('code')
                with backend(lambda path: response) as (url, requests):
                    instance = self.instance(url)
                    self.assertEqual(instance.prefetch('synthetic query'), '')
                    self.assertEqual(instance._consecutive_failures, 1)

    def test_numeric_float_zero_keeps_successful_gateway_compatibility(self):
        response = {'code': 0.0, 'data': {'items': [], 'content': 'synthetic numeric-zero persona', 'entries': []}}
        with backend(lambda path: response) as (url, requests):
            instance = self.instance(url); instance._consecutive_failures = 2
            self.assertIn('synthetic numeric-zero persona', instance.prefetch('synthetic query'))
            self.assertEqual(instance._consecutive_failures, 0)
            self.assertEqual(len(requests), 3)

    def test_partial_real_success_is_retained_without_rejected_error_data(self):
        def respond(path):
            if path == '/v3/atomic/search': return rejected()
            return {'code': 0, 'data': {'content': 'synthetic valid persona', 'entries': []}}
        with backend(respond) as (url, requests):
            instance = self.instance(url); instance._consecutive_failures = 2
            with self.assertLogs(provider.logger, level='DEBUG') as captured:
                result = instance.prefetch('synthetic query')
            self.assertIn('synthetic valid persona', result)
            self.assert_rejected_data_absent(result + '\n'.join(captured.output))
            self.assertEqual(instance._consecutive_failures, 0)

    def test_repeated_application_errors_open_breaker_and_skip_new_calls(self):
        with backend(lambda path: rejected()) as (url, requests):
            instance = self.instance(url)
            for number in range(1, provider._BREAKER_THRESHOLD + 1):
                self.assertEqual(instance.prefetch('synthetic query'), '')
                self.assertEqual(instance._consecutive_failures, number)
            self.assertTrue(instance._is_breaker_open())
            self.assertEqual(len(requests), provider._BREAKER_THRESHOLD * 3)
            self.assertEqual(instance.prefetch('synthetic query'), '')
            instance.sync_turn('synthetic user', 'synthetic assistant')
            self.assertEqual(len(requests), provider._BREAKER_THRESHOLD * 3)
            self.assertEqual(instance._active_syncs, [])

if __name__ == '__main__': unittest.main()
