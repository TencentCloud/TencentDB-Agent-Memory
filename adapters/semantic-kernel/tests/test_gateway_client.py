"""Gateway client contract tests: payloads, auth, error mapping."""

from __future__ import annotations

import pytest

from tdai_sk import GatewayError
from tdai_sk.gateway_client import MemoryGatewayClient


async def test_health_and_bearer_auth_on_write_paths(fake_gw):
    gw, url = fake_gw
    async with MemoryGatewayClient(gateway_url=url, api_key="k1") as client:
        health = await client.health()
        assert health.status == "ok"
        assert health.version == "test-gateway"
        await client.recall("q", "sk", user_id="u")
        await client.search_memories("q", user_id="u")
        await client.search_conversations("q", session_key="s:k")
        await client.end_session("s:k", user_id="u")
    # health carries no auth requirement; write paths must carry the bearer
    auth_by_path = {p: a for p, a, _ in gw.requests}
    assert auth_by_path["/recall"] == "Bearer k1"
    assert auth_by_path["/search/memories"] == "Bearer k1"
    assert auth_by_path["/search/conversations"] == "Bearer k1"
    assert auth_by_path["/session/end"] == "Bearer k1"


async def test_search_payload_shapes(fake_gw):
    gw, url = fake_gw
    async with MemoryGatewayClient(gateway_url=url) as client:
        result = await client.search_memories("codename", limit=3, user_id="u")
        assert "Apollo Lake" in result.results
        await client.search_conversations("codename", session_key="s:k", limit=2)
    mem_payload = gw.payloads("/search/memories")[0]
    assert mem_payload == {"query": "codename", "limit": 3, "user_id": "u"}
    conv_payload = gw.payloads("/search/conversations")[0]
    assert conv_payload == {"query": "codename", "limit": 2, "session_key": "s:k"}


async def test_recall_payload_and_result_mapping(fake_gw):
    gw, url = fake_gw
    async with MemoryGatewayClient(gateway_url=url) as client:
        recall = await client.recall("what is my codename", "s:k", user_id="u")
    assert "Apollo Lake" in recall.context
    assert recall.memory_count == 1
    payload = gw.payloads("/recall")[0]
    assert payload == {
        "query": "what is my codename",
        "session_key": "s:k",
        "user_id": "u",
    }


async def test_server_error_raises_gateway_error(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/recall")
    async with MemoryGatewayClient(gateway_url=url) as client:
        with pytest.raises(GatewayError, match="500"):
            await client.recall("q", "sk")


async def test_unreachable_gateway_raises_gateway_error():
    # port 1 on loopback: nothing listens there
    async with MemoryGatewayClient(gateway_url="http://127.0.0.1:1") as client:
        with pytest.raises(GatewayError):
            await client.health()
