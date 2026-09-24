from unittest.mock import AsyncMock, Mock

import pytest

from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3.client import AsyncMemoryClient, MemoryClient


@pytest.fixture(params=[MemoryClient, AsyncMemoryClient], ids=["sync", "async"])
def client_and_stub(request):
    stub = Mock()
    stub.post = (
        AsyncMock(return_value={})
        if request.param is AsyncMemoryClient
        else Mock(return_value={})
    )
    client = request.param(
        team_id="team-test",
        agent_id="agent-test",
        user_id="user-test",
        session_id="constructor-session-must-not-be-deleted",
        stub=stub,
    )
    return client, stub


async def delete_conversation(client, **kwargs):
    if isinstance(client, AsyncMemoryClient):
        return await client.delete_conversation(**kwargs)
    return client.delete_conversation(**kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("message_ids", [None, ["message-1"]])
async def test_rejects_overflow_after_merging_legacy_session(client_and_stub, message_ids):
    client, stub = client_and_stub
    session_ids = [f"session-{index}" for index in range(100)]

    with pytest.raises(ParamError, match="session_ids accepts at most 100 items, got 101"):
        await delete_conversation(
            client,
            session_ids=session_ids,
            session_id="session-extra",
            message_ids=message_ids,
        )

    stub.post.assert_not_called()
    assert len(session_ids) == 100


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "session_ids, legacy, expected",
    [
        (
            [f"session-{index}" for index in range(99)],
            "session-99",
            [f"session-{index}" for index in range(100)],
        ),
        (
            [f"session-{index}" for index in range(100)],
            "session-0",
            [f"session-{index}" for index in range(100)],
        ),
        (
            [f"session-{index}" for index in range(100)] + ["session-0"],
            " session-0 ",
            [f"session-{index}" for index in range(100)],
        ),
        (None, " legacy-session ", ["legacy-session"]),
    ],
    ids=["boundary", "duplicate-legacy", "trim-and-deduplicate", "legacy-only"],
)
async def test_accepts_normalized_sessions_at_or_below_limit(
    client_and_stub, session_ids, legacy, expected
):
    client, stub = client_and_stub
    original = list(session_ids) if session_ids is not None else None

    await delete_conversation(client, session_ids=session_ids, session_id=legacy)

    stub.post.assert_called_once_with(
        "/v3/conversation/delete",
        {
            "team_id": "team-test",
            "agent_id": "agent-test",
            "user_id": "user-test",
            "session_ids": expected,
        },
    )
    assert session_ids == original


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", ["", "   "])
async def test_rejects_empty_legacy_session(client_and_stub, legacy):
    client, stub = client_and_stub
    with pytest.raises(ParamError, match="session_id must be a non-empty string"):
        await delete_conversation(client, session_id=legacy)
    stub.post.assert_not_called()


@pytest.mark.asyncio
async def test_message_only_delete_does_not_use_constructor_session(client_and_stub):
    client, stub = client_and_stub
    await delete_conversation(client, message_ids=["message-1"])
    stub.post.assert_called_once_with(
        "/v3/conversation/delete",
        {
            "team_id": "team-test",
            "agent_id": "agent-test",
            "user_id": "user-test",
            "message_ids": ["message-1"],
        },
    )
