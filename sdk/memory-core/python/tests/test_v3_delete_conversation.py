"""``v3.MemoryClient.delete_conversation`` guard semantics.

The deprecated singular ``session_id`` must be merged into
``session_ids`` *before* the ≤100 limit check: the server merges the
two fields first and then refines the merged list (see
``conversationDeleteRequestSchema``), so merging after the client-side
guard lets a "100 session_ids + 1 session_id" request through with 101
items and get rejected server-side — exactly the failure the guard
exists to surface earlier.
"""

import asyncio

import pytest

from tencentdb_agent_memory._http import Stub
from tencentdb_agent_memory.errors import ParamError
from tencentdb_agent_memory.v3.client import AsyncMemoryClient, MemoryClient

IDS_100 = [f"s{i:03d}" for i in range(100)]


class _RecordingStub(Stub):
    def __init__(self) -> None:
        self.bodies = []

    def post(self, path, body, timeout=None):
        self.bodies.append((path, body))
        return {}

    def close(self):
        pass


class _AsyncRecordingStub(_RecordingStub):
    async def close(self):
        pass


def _client(**kwargs):
    stub = _RecordingStub()
    client = MemoryClient(
        stub=stub, team_id="t", agent_id="a", user_id="u", **kwargs
    )
    return client, stub


# -- the guard must apply to the *merged* list -------------------------------

def test_merged_singular_session_id_enforces_limit():
    client, stub = _client()
    with pytest.raises(ParamError) as excinfo:
        client.delete_conversation(session_ids=IDS_100, session_id="s100")
    assert "at most 100" in str(excinfo.value)
    assert stub.bodies == []
    client.close()


def test_merged_singular_session_id_dedupes_before_limit():
    client, stub = _client()
    client.delete_conversation(session_ids=IDS_100, session_id=f" {IDS_100[42]} ")
    body = stub.bodies[0][1]
    assert body["session_ids"] == IDS_100
    client.close()


def test_invalid_session_ids_type_with_singular_is_rejected():
    client, stub = _client()
    with pytest.raises(ParamError, match="session_ids must be a list"):
        client.delete_conversation(session_ids="s1", session_id="s2")
    assert stub.bodies == []
    client.close()


# -- existing documented behavior, kept as regression guards ------------------

def test_singular_only_becomes_session_ids():
    client, stub = _client()
    client.delete_conversation(session_id="solo")
    body = stub.bodies[0][1]
    assert body["session_ids"] == ["solo"]
    assert "session_id" not in body
    assert "message_ids" not in body
    client.close()


def test_constructor_session_id_not_used_for_deletes():
    client, stub = _client(session_id="bound")
    with pytest.raises(ParamError, match="intentionally NOT used"):
        client.delete_conversation()
    assert stub.bodies == []
    client.close()


def test_message_ids_are_deduped():
    client, stub = _client()
    client.delete_conversation(message_ids=["m1", "m1", "m2"])
    body = stub.bodies[0][1]
    assert body["message_ids"] == ["m1", "m2"]
    client.close()


# -- async variant shares the same guard --------------------------------------

def test_async_merged_singular_session_id_enforces_limit():
    async def main():
        stub = _AsyncRecordingStub()
        client = AsyncMemoryClient(
            stub=stub, team_id="t", agent_id="a", user_id="u"
        )
        try:
            with pytest.raises(ParamError, match="at most 100"):
                await client.delete_conversation(
                    session_ids=IDS_100, session_id="s100"
                )
            assert stub.bodies == []
        finally:
            await client.close()

    asyncio.run(main())
