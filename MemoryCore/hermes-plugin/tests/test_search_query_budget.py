"""Hermes recall must fit the Gateway's query budget without shortening stored history."""

import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


# The HTTP client runs independently of the Hermes host.
client_path = Path(__file__).resolve().parents[1] / "memory/memory_tencentdb/client.py"
spec = importlib.util.spec_from_file_location("hermes_memory_client", client_path)
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)


class SearchQueryBudgetTest(unittest.TestCase):
    def setUp(self):
        self.client = client_module.MemoryTencentdbSdkClient()
        mock_urlopen = patch("urllib.request.urlopen")
        self.urlopen = mock_urlopen.start()
        self.addCleanup(mock_urlopen.stop)
        self.urlopen.return_value.__enter__.return_value.read.return_value = b'{"code":0,"data":{}}'

    def posted_body(self):
        request = self.urlopen.call_args.args[0]
        return json.loads(request.data)

    def test_long_queries_keep_both_ends_on_all_search_routes(self):
        head, tail = "定时任务：整理评论。", "我上次说喜欢哪台掌机？"
        query = head + "🙂评论" * 1500 + tail
        for search, args in [
            (self.client.atomic_search, (query,)),
            (self.client.conversation_search, (query,)),
            (self.client.recall, (query, "session")),
            (self.client.search_memories, (query,)),
            (self.client.search_conversations, (query,)),
        ]:
            with self.subTest(method=search.__name__):
                search(*args)
                sent = self.posted_body()["query"]
                self.assertLessEqual(len(sent.encode("utf-16-le")) // 2, 2048)
                self.assertTrue(sent.startswith(head))
                self.assertTrue(sent.endswith(tail))

    def test_queries_within_budget_are_unchanged(self):
        for query in ("  我喜欢什么？\n", "a" * 2048, "汉" * 2048, "🚀" * 1024):
            with self.subTest(length=len(query)):
                self.client.atomic_search(query)
                self.assertEqual(self.posted_body()["query"], query)

    def test_emoji_can_exceed_the_limit_with_fewer_than_2048_code_points(self):
        query = "🚀" * 1024 + "？"
        self.client.atomic_search(query)
        sent = self.posted_body()["query"]
        self.assertLessEqual(len(sent.encode("utf-16-le")) // 2, 2048)
        self.assertTrue(sent.startswith("🚀"))
        self.assertTrue(sent.endswith("🚀？"))

    def test_capture_preserves_the_full_message(self):
        messages = [{"role": "user", "content": "记忆" * 2000}]
        self.client.conversation_add(messages, session_id="example")
        self.assertEqual(self.posted_body()["messages"], messages)


if __name__ == "__main__":
    unittest.main()
