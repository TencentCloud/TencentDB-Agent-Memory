"""DifyEventBinding 契约测试。

验证 Dify 扩展点 / 工具调用 → ``MemoryTencentdbSdkClient`` 调用的映射正确，
以及「记忆永不阻塞对话」的软失败契约。全部用 mock client，不发真实 HTTP。

运行：
    cd <repo>
    python -m pytest dify-plugin/tests/test_event_binding.py -v
"""

from __future__ import annotations

import json
import pathlib
import sys
from unittest.mock import MagicMock

import pytest

# 把 dify-plugin/ 加入 sys.path 以导入 dify_memory_tencentdb 包
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_DIFY_PLUGIN_DIR = _REPO_ROOT / "dify-plugin"
if str(_DIFY_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_DIFY_PLUGIN_DIR))

from dify_memory_tencentdb import DifyEventBinding  # noqa: E402
from dify_memory_tencentdb.event_binding import _clamp_limit  # noqa: E402


# ============================
# 辅助：构造 mock client + binding
# ============================


def make_mock_client():
    """构造一个 duck-typed 的 mock client，记录每次调用的参数。"""
    client = MagicMock()
    client.recall.return_value = {"context": "用户喜欢 Python 装饰器", "strategy": "keyword"}
    client.capture.return_value = {"l0_recorded": 2, "scheduler_notified": True}
    client.search_memories.return_value = {"results": [{"type": "episodic", "text": "..."}]}
    client.search_conversations.return_value = {"results": [{"role": "user", "text": "..."}]}
    client.end_session.return_value = {"flushed": True}
    return client


def make_binding(client=None, **kw):
    client = client or make_mock_client()
    return DifyEventBinding(client=client, session_key="dify-demo-session", **kw), client


# ============================
# on_user_prompt（recall）
# ============================


class TestOnUserPrompt:
    def test_正常返回上下文_带记忆头(self):
        binding, client = make_binding()
        ctx = binding.on_user_prompt("装饰器怎么用？")
        assert "## memory-tencentdb Memory" in ctx
        assert "用户喜欢 Python 装饰器" in ctx
        client.recall.assert_called_once_with(
            query="装饰器怎么用？",
            session_key="dify-demo-session",
            user_id="default_user",
        )

    def test_空_query_直接返回空串_不发请求(self):
        binding, client = make_binding()
        assert binding.on_user_prompt("") == ""
        client.recall.assert_not_called()

    def test_recall_返回空_context_返回空串(self):
        binding, client = make_binding()
        client.recall.return_value = {"context": ""}
        assert binding.on_user_prompt("q") == ""

    def test_client_抛异常_软失败返回空串(self):
        binding, client = make_binding()
        client.recall.side_effect = RuntimeError("gateway down")
        assert binding.on_user_prompt("q") == ""

    def test_session_key_覆盖(self):
        binding, client = make_binding()
        binding.on_user_prompt("q", session_key="other-session")
        client.recall.assert_called_once_with(
            query="q", session_key="other-session", user_id="default_user"
        )


# ============================
# on_turn_end（capture）
# ============================


class TestOnTurnEnd:
    def test_正常返回_capture_ack(self):
        binding, client = make_binding()
        ack = binding.on_turn_end("什么是闭包", "闭包是……")
        assert ack == {"l0_recorded": 2, "scheduler_notified": True}
        client.capture.assert_called_once_with(
            user_content="什么是闭包",
            assistant_content="闭包是……",
            session_key="dify-demo-session",
            user_id="default_user",
        )

    def test_空_user_content_返回_None_不发请求(self):
        binding, client = make_binding()
        assert binding.on_turn_end("", "reply") is None
        client.capture.assert_not_called()

    def test_空_assistant_content_返回_None(self):
        binding, client = make_binding()
        assert binding.on_turn_end("q", "") is None

    def test_client_抛异常_软失败返回_None(self):
        binding, client = make_binding()
        client.capture.side_effect = RuntimeError("timeout")
        assert binding.on_turn_end("u", "a") is None


# ============================
# on_session_end
# ============================


class TestOnSessionEnd:
    def test_正常调用_end_session(self):
        binding, client = make_binding()
        binding.on_session_end()
        client.end_session.assert_called_once_with(
            session_key="dify-demo-session", user_id="default_user"
        )

    def test_client_抛异常_静默不抛(self):
        binding, client = make_binding()
        client.end_session.side_effect = RuntimeError("flush failed")
        # 不应抛
        binding.on_session_end()


# ============================
# get_tool_schemas
# ============================


class TestGetToolSchemas:
    def test_返回三个工具_schema(self):
        binding, _ = make_binding()
        schemas = binding.get_tool_schemas()
        names = [s["name"] for s in schemas]
        assert names == ["tdai_memory_search", "tdai_conversation_search", "tdai_capture"]

    def test_每个_schema_有_name_description_parameters(self):
        binding, _ = make_binding()
        for s in binding.get_tool_schemas():
            assert "name" in s and "description" in s and "parameters" in s
            assert s["parameters"]["type"] == "object"


# ============================
# Dify 扩展点适配器
# ============================


class TestHandleExternalDataToolQuery:
    def test_返回_result_字段_含_recall_上下文(self):
        binding, _ = make_binding()
        resp = binding.handle_external_data_tool_query(
            {"app_id": "x", "tool_variable": "tdai_recall", "inputs": {}, "query": "装饰器"}
        )
        assert resp["result"].startswith("## memory-tencentdb Memory")
        assert "用户喜欢 Python 装饰器" in resp["result"]

    def test_空_query_返回空_result(self):
        binding, _ = make_binding()
        resp = binding.handle_external_data_tool_query({"query": ""})
        assert resp == {"result": ""}


class TestHandleToolCall:
    def test_tdai_memory_search_调用_search_memories(self):
        binding, client = make_binding()
        out = json.loads(binding.handle_tool_call("tdai_memory_search", {"query": "闭包", "limit": 3}))
        assert "results" in out
        client.search_memories.assert_called_once_with(
            query="闭包", limit=3, type_filter="", scene=""
        )

    def test_tdai_conversation_search_调用_search_conversations(self):
        binding, client = make_binding()
        out = json.loads(
            binding.handle_tool_call("tdai_conversation_search", {"query": "上次对话", "limit": 10})
        )
        assert "results" in out
        client.search_conversations.assert_called_once_with(
            query="上次对话", limit=10, session_key=""
        )

    def test_tdai_capture_调用_on_turn_end(self):
        binding, _ = make_binding()
        out = json.loads(
            binding.handle_tool_call(
                "tdai_capture", {"user_content": "u", "assistant_content": "a"}
            )
        )
        assert out == {"l0_recorded": 2, "scheduler_notified": True}

    def test_未知工具_返回_error(self):
        binding, _ = make_binding()
        out = json.loads(binding.handle_tool_call("nope", {}))
        assert "error" in out and "Unknown" in out["error"]

    def test_memory_search_缺_query_返回_error(self):
        binding, _ = make_binding()
        out = json.loads(binding.handle_tool_call("tdai_memory_search", {}))
        assert "error" in out

    def test_client_抛异常_返回_error_json(self):
        binding, client = make_binding()
        client.search_memories.side_effect = RuntimeError("boom")
        out = json.loads(binding.handle_tool_call("tdai_memory_search", {"query": "x"}))
        assert "error" in out


# ============================
# _clamp_limit
# ============================


class TestClampLimit:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            (None, 5),
            (True, 5),   # bool 被拒绝
            (False, 5),
            ("", 5),
            ("abc", 5),
            (0, 1),
            (1, 1),
            (5, 5),
            (20, 20),
            (25, 20),
            ("3", 3),     # 数字字符串
            (3.7, 3),     # float 截断
        ],
    )
    def test_clamp(self, raw, expected):
        assert _clamp_limit(raw) == expected


# ============================
# host_type
# ============================


def test_host_type_is_dify():
    binding, _ = make_binding()
    assert binding.host_type == "dify"
