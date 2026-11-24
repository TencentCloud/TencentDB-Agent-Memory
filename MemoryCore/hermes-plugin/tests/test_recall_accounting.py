"""Recall/circuit accounting with the real provider and synthetic client calls.

Only the external Hermes MemoryProvider base interface is replaced.
"""
import importlib.util
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'memory/memory_tencentdb'
agent = types.ModuleType('agent'); agent.__path__ = []
interface = types.ModuleType('agent.memory_provider')
interface.MemoryProvider = type('MemoryProvider', (), {})
saved = {name: sys.modules.get(name) for name in ('agent', 'agent.memory_provider')}
sys.modules['agent'] = agent; sys.modules['agent.memory_provider'] = interface
try:
    spec = importlib.util.spec_from_file_location('recall_provider', ROOT / '__init__.py', submodule_search_locations=[str(ROOT)])
    provider = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = provider
    spec.loader.exec_module(provider)
finally:
    for name, old in saved.items():
        if old is None: sys.modules.pop(name, None)
        else: sys.modules[name] = old

class RecallAccountingTests(unittest.TestCase):
    def instance(self):
        instance = provider.MemoryTencentdbProvider()
        instance._gateway_available = True
        instance._client = provider.MemoryTencentdbSdkClient('http://127.0.0.1:9', timeout=0.01)
        self.calls = []
        def empty(**kwargs):
            self.calls.append(kwargs)
            return {'code': 0, 'data': {}}
        def fail(**kwargs):
            self.calls.append(kwargs)
            raise ConnectionError('synthetic failure')
        self.empty = empty; self.failing_request = fail
        instance._client.atomic_search = empty
        instance._client.core_read = empty
        instance._client.scenario_ls = empty
        return instance

    def test_all_three_failures_count_once_per_recall_and_open_breaker(self):
        instance = self.instance()
        instance._client.atomic_search = self.failing_request
        instance._client.core_read = self.failing_request
        instance._client.scenario_ls = self.failing_request
        for number in range(1, provider._BREAKER_THRESHOLD + 1):
            self.assertEqual(instance.prefetch('synthetic query'), '')
            self.assertEqual(instance._consecutive_failures, number)
        self.assertTrue(instance._is_breaker_open())
        count = len(self.calls)
        self.assertEqual(instance.prefetch('synthetic query'), '')
        self.assertEqual(len(self.calls), count)

    def test_partial_success_retains_context_and_resets_failures(self):
        instance = self.instance()
        instance._consecutive_failures = 2
        instance._client.atomic_search = self.failing_request
        instance._client.core_read = lambda **kwargs: {'code': 0, 'data': {'content': 'synthetic persona'}}
        self.assertIn('<user-core>\nsynthetic persona\n</user-core>', instance.prefetch('synthetic query'))
        self.assertEqual(instance._consecutive_failures, 0)

    def test_successful_empty_responses_are_success_not_outage(self):
        instance = self.instance()
        instance._consecutive_failures = 2
        self.assertEqual(instance.prefetch('synthetic query'), '')
        self.assertEqual(instance._consecutive_failures, 0)
        self.assertEqual(len(self.calls), 3)

    def test_open_breaker_blocks_recall_and_background_capture_even_if_available(self):
        instance = self.instance()
        instance._consecutive_failures = provider._BREAKER_THRESHOLD
        instance._breaker_open_until = float('inf')
        instance._client.conversation_add = self.empty
        self.assertEqual(instance.prefetch('synthetic query'), '')
        instance.sync_turn('synthetic user', 'synthetic reply')
        for thread in instance._active_syncs:
            thread.join(timeout=1)
        self.assertEqual(self.calls, [])
        self.assertEqual(instance._active_syncs, [])

    def test_expired_breaker_allows_recall_again(self):
        instance = self.instance()
        instance._consecutive_failures = provider._BREAKER_THRESHOLD
        instance._breaker_open_until = 10
        with patch.object(provider.time, 'monotonic', return_value=11):
            self.assertEqual(instance.prefetch('synthetic query'), '')
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(instance._consecutive_failures, 0)

    def test_deadline_without_completed_response_counts_failure_and_late_workers_do_not_reset(self):
        instance = self.instance()
        release = threading.Event()
        finished = [threading.Event() for _ in range(3)]
        def wait(number):
            def call(**kwargs):
                release.wait(timeout=2)
                finished[number].set()
                return {'code': 0, 'data': {'content': 'late synthetic persona'}}
            return call
        instance._client.atomic_search = wait(0)
        instance._client.core_read = wait(1)
        instance._client.scenario_ls = wait(2)
        try:
            self.assertEqual(instance.prefetch('synthetic query'), '')
            self.assertEqual(instance._consecutive_failures, 1)
        finally:
            release.set()
            for event in finished:
                self.assertTrue(event.wait(timeout=1))
        self.assertEqual(instance._consecutive_failures, 1)

if __name__ == '__main__':
    unittest.main()
