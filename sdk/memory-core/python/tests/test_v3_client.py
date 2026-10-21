"""Offline contracts shared by the synchronous and asynchronous v3 clients."""

import asyncio
import inspect
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3.client import AsyncMemoryClient, MemoryClient


def invoke(method, **kwargs):
    result = method(**kwargs)
    return asyncio.run(result) if inspect.isawaitable(result) else result


@pytest.fixture(params=[MemoryClient, AsyncMemoryClient], ids=["sync", "async"])
def client_and_post(request):
    post = (AsyncMock if request.param is AsyncMemoryClient else Mock)(return_value={"ok": True})
    client = request.param(
        team_id="team-a", agent_id="agent-a", user_id="user-a",
        session_id="bound-session", task_id="task-a", stub=SimpleNamespace(post=post),
    )
    return client, post


def test_write_requires_explicit_or_bound_session_before_network(client_and_post):
    client, post = client_and_post
    unbound = client.with_isolation(session_id=None)
    with pytest.raises(ValueError, match="requires session_id"):
        invoke(unbound.add_conversation, messages=[])
    post.assert_not_called()
    assert invoke(unbound.add_conversation, messages=[{"role": "user", "content": "hello"}], session_id="new-session") == {"ok": True}
    assert post.call_args.args[1]["session_id"] == "new-session"
    assert post.call_args.args[0] == "/v3/conversation/add"


def test_cloned_isolation_does_not_change_original_and_can_clear_session(client_and_post):
    client, post = client_and_post
    clone = client.with_isolation(agent_id="agent-b", session_id=None, task_id=None)
    assert invoke(clone.query_conversation, limit=0, offset=0) == {"ok": True}
    assert post.call_args.args[1] == {
        "team_id": "team-a", "agent_id": "agent-b", "user_id": "user-a", "limit": 0, "offset": 0,
    }
    invoke(client.query_conversation)
    assert post.call_args.args[1] == {
        "team_id": "team-a", "agent_id": "agent-a", "user_id": "user-a",
        "task_id": "task-a", "session_id": "bound-session",
    }


def test_delete_never_implicitly_uses_the_bound_session(client_and_post):
    client, post = client_and_post
    with pytest.raises(ParamError, match="requires message_ids or session_ids"):
        invoke(client.delete_conversation)
    post.assert_not_called()
    assert invoke(client.delete_conversation, message_ids=[" m1 ", "m1", "m2"]) == {"ok": True}
    assert post.call_args.args[0] == "/v3/conversation/delete"
    body = post.call_args.args[1]
    assert body["message_ids"] == ["m1", "m2"]
    assert "session_ids" not in body
    assert "session_id" not in body


@pytest.mark.parametrize("ids", [[" "], [None], [1], "message-id", []])
def test_invalid_deletion_does_not_reach_transport(client_and_post, ids):
    client, post = client_and_post
    with pytest.raises(ParamError):
        invoke(client.delete_conversation, message_ids=ids)
    post.assert_not_called()


def test_session_delete_limit_applies_after_merging_legacy_parameter(client_and_post):
    client, post = client_and_post
    sessions = [f"session-{i}" for i in range(100)]
    with pytest.raises(ParamError, match="at most 100"):
        invoke(client.delete_conversation, session_ids=sessions, session_id="one-too-many")
    post.assert_not_called()


def test_duplicate_legacy_session_at_limit_is_accepted_without_mutating_input(client_and_post):
    client, post = client_and_post
    sessions = [f"session-{i}" for i in range(100)]
    invoke(client.delete_conversation, session_ids=sessions, session_id=" session-0 ")
    assert post.call_args.args[1]["session_ids"] == sessions
    assert len(sessions) == 100


def test_message_delete_limit_counts_unique_ids(client_and_post):
    client, post = client_and_post
    ids = [f"message-{i}" for i in range(5000)]
    invoke(client.delete_conversation, message_ids=ids + [ids[0]])
    assert post.call_args.args[1]["message_ids"] == ids
    post.reset_mock()
    with pytest.raises(ParamError, match="at most 5000"):
        invoke(client.delete_conversation, message_ids=ids + ["overflow"])
    post.assert_not_called()


@pytest.mark.parametrize("missing", ["team_id", "agent_id", "user_id"])
@pytest.mark.parametrize("client_type", [MemoryClient, AsyncMemoryClient])
def test_required_isolation_checked_at_construction(missing, client_type):
    isolation = {"team_id": "team", "agent_id": "agent", "user_id": "user"}
    isolation[missing] = ""
    with pytest.raises(ParamError, match=missing):
        client_type(**isolation, stub=SimpleNamespace(post=Mock()))
