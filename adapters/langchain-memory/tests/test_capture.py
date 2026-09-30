from __future__ import annotations

import asyncio

from tencentdb_langchain import acapture_conversation, capture_conversation
from tencentdb_langchain.capture import langchain_messages_to_dicts

from conftest import build_async_memory, build_sync_memory


def test_langchain_messages_to_dicts_maps_roles():
    class _Msg:
        def __init__(self, type_, content):
            self.type = type_
            self.content = content

    msgs = [_Msg("human", "hi"), _Msg("ai", "hello")]
    assert langchain_messages_to_dicts(msgs) == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]


def test_capture_conversation_sync():
    memory = build_sync_memory({"/v3/conversation/add": {"accepted_ids": ["m1"]}})
    ids = capture_conversation(memory, [{"role": "user", "content": "hi"}], session_id="s1")
    assert ids == ["m1"]


def test_acapture_conversation_async():
    memory = build_async_memory({"/v3/conversation/add": {"accepted_ids": ["m1"]}})
    ids = asyncio.run(
        acapture_conversation(memory, [{"role": "user", "content": "hi"}], session_id="s1")
    )
    assert ids == ["m1"]
