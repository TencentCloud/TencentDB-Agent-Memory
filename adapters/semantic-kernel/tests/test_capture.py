"""Thread capture and session lifecycle tests."""

from __future__ import annotations

import pytest

from tdai_sk import TDAiConfig, TencentDBAgentMemory


def _make_thread(thread_id: str = "t-1", pairs: int = 1):
    from semantic_kernel.agents.chat_completion.chat_completion_agent import (
        ChatHistoryAgentThread,
    )
    from semantic_kernel.contents.chat_history import ChatHistory
    from semantic_kernel.contents.chat_message_content import ChatMessageContent
    from semantic_kernel.contents.utils.author_role import AuthorRole

    history = ChatHistory()
    for i in range(pairs):
        history.add_message(
            ChatMessageContent(
                role=AuthorRole.USER, content=f"Remember: fact {i + 1} (codename Apollo Lake)."
            )
        )
        history.add_message(
            ChatMessageContent(role=AuthorRole.ASSISTANT, content=f"Noted fact {i + 1}.")
        )
    return ChatHistoryAgentThread(chat_history=history, thread_id=thread_id)


async def test_capture_sends_full_payload(fake_gw):
    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, api_key="k1"))
    thread = _make_thread()

    response = await mem.capture_thread(thread)
    assert response is not None and response["l0_recorded"] == 2
    payload = gw.payloads("/capture")[0]
    assert payload["user_content"] == "Remember: fact 1 (codename Apollo Lake)."
    assert payload["assistant_content"] == "Noted fact 1."
    assert payload["session_id"] == "t-1"
    assert payload["user_id"] == "default-user"
    assert len(payload["messages"]) == 2
    assert payload["messages"][0]["role"] == "user"
    assert payload["messages"][1]["role"] == "assistant"
    assert payload["session_key"].endswith("dC0x")  # b64url("t-1")
    await mem.close()


async def test_capture_is_incremental(fake_gw):
    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    thread = _make_thread(pairs=2)

    first = await mem.capture_thread(thread)
    assert first is not None and first["l0_recorded"] == 4
    # nothing new → no request, None result
    count_before = len(gw.requests)
    assert await mem.capture_thread(thread) is None
    assert len(gw.requests) == count_before
    await mem.close()


async def test_capture_ignores_incomplete_turn(fake_gw):
    from semantic_kernel.agents.chat_completion.chat_completion_agent import (
        ChatHistoryAgentThread,
    )
    from semantic_kernel.contents.chat_history import ChatHistory
    from semantic_kernel.contents.chat_message_content import ChatMessageContent
    from semantic_kernel.contents.utils.author_role import AuthorRole

    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    history = ChatHistory()
    history.add_message(ChatMessageContent(role=AuthorRole.USER, content="orphan"))
    thread = ChatHistoryAgentThread(chat_history=history, thread_id="t-2")

    assert await mem.capture_thread(thread) is None
    assert gw.payloads("/capture") == []
    await mem.close()


async def test_capture_fail_open_returns_none(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/capture")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=True))
    thread = _make_thread()

    assert await mem.capture_thread(thread) is None
    # watermark NOT advanced → the delta will be retried next call
    assert mem._captured_counts.get("t-1") is None
    await mem.close()


async def test_capture_retries_after_failure(fake_gw):
    """A failed capture is resent once the gateway recovers, exactly once."""
    gw, url = fake_gw
    gw.fail_routes.add("/capture")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=True))
    thread = _make_thread()

    assert await mem.capture_thread(thread) is None  # reaches gateway, gets 500
    gw.fail_routes.clear()  # gateway recovers
    response = await mem.capture_thread(thread)  # resends the same delta
    assert response is not None and response["l0_recorded"] == 2
    captures = gw.payloads("/capture")
    # Exactly two attempts — the failed one and the retry — with identical
    # content (the watermark only advances on success).
    assert len(captures) == 2
    assert captures[0]["user_content"] == captures[1]["user_content"]
    # A third call is a no-op (watermark advanced by the success).
    assert await mem.capture_thread(thread) is None
    assert len(gw.payloads("/capture")) == 2
    await mem.close()


async def test_capture_watermarks_isolated_per_thread(fake_gw):
    """Two threads sharing one facade never leak capture deltas."""
    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    thread_a = _make_thread("t-a")
    thread_b = _make_thread("t-b")

    await mem.capture_thread(thread_a)
    await mem.capture_thread(thread_b)  # b sends its own full pair
    captures = gw.payloads("/capture")
    assert len(captures) == 2
    assert {c["session_id"] for c in captures} == {"t-a", "t-b"}
    # Nothing new afterwards for either thread.
    await mem.capture_thread(thread_a)
    await mem.capture_thread(thread_b)
    assert len(gw.payloads("/capture")) == 2
    await mem.close()


async def test_capture_fail_closed_raises(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/capture")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=False))
    thread = _make_thread()

    with pytest.raises(Exception, match="500"):
        await mem.capture_thread(thread)
    await mem.close()


async def test_end_session_flushes(fake_gw):
    gw, url = fake_gw
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url))
    thread = _make_thread()

    assert await mem.end_session(thread) is True
    payload = gw.payloads("/session/end")[0]
    assert payload["session_key"].endswith("dC0x")
    await mem.close()


async def test_end_session_fail_open_returns_false(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/session/end")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=True))
    thread = _make_thread()

    assert await mem.end_session(thread) is False
    await mem.close()


async def test_end_session_fail_closed_raises(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/session/end")
    mem = TencentDBAgentMemory(TDAiConfig(gateway_url=url, fail_open=False))
    thread = _make_thread()

    with pytest.raises(Exception, match="500"):
        await mem.end_session(thread)
    await mem.close()
