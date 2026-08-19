"""TencentDBMemoryService contract tests: store/search/lifecycle paths."""

from __future__ import annotations

import pytest

from tdai_trpc import TDAiConfig, TencentDBMemoryService

from conftest import make_event, make_session


def make_service(url: str, **config_kwargs) -> TencentDBMemoryService:
    return TencentDBMemoryService(TDAiConfig(gateway_url=url, **config_kwargs))


async def test_enabled_by_default():
    service = TencentDBMemoryService(
        TDAiConfig(gateway_url="http://127.0.0.1:1"), validate_config=False
    )
    assert service.enabled is True  # runner gates store_session on this
    await service.close()


async def test_store_session_sends_full_payload(fake_gw):
    gw, url = fake_gw
    service = make_service(url, api_key="k1")
    session = make_session(pairs=1)

    await service.store_session(session)

    payload = gw.payloads("/capture")[0]
    assert payload["user_content"] == "Remember fact 1: codename is Apollo Lake."
    assert payload["assistant_content"] == "Noted fact 1."
    assert payload["session_id"] == "s-1"
    assert payload["user_id"] == "user"
    assert len(payload["messages"]) == 2
    assert payload["messages"][0]["role"] == "user"
    assert payload["messages"][1]["role"] == "assistant"
    # session_key = b64url("app"):b64url("user"):b64url("s-1") from save_key
    assert payload["session_key"].count(":") == 2
    await service.close()


async def test_store_session_is_incremental(fake_gw):
    gw, url = fake_gw
    service = make_service(url)
    session = make_session(pairs=1)

    await service.store_session(session)
    session.add_event(make_event("user", "Second question?"))
    session.add_event(make_event("agent", "Second answer."))

    await service.store_session(session)
    captures = gw.payloads("/capture")
    assert len(captures) == 2
    assert captures[1]["user_content"] == "Second question?"
    assert captures[1]["assistant_content"] == "Second answer."
    # Nothing new: third call sends nothing.
    await service.store_session(session)
    assert len(gw.payloads("/capture")) == 2
    await service.close()


async def test_store_session_ignores_incomplete_turn(fake_gw):
    gw, url = fake_gw
    service = make_service(url)
    session = make_session(pairs=1)
    await service.store_session(session)

    session.add_event(make_event("user", "orphan question"))
    await service.store_session(session)
    assert len(gw.payloads("/capture")) == 1  # nothing sent for the lone user msg

    # Once the assistant replies, the pending pair is captured.
    session.add_event(make_event("agent", "late answer"))
    await service.store_session(session)
    captures = gw.payloads("/capture")
    assert len(captures) == 2
    assert captures[1]["user_content"] == "orphan question"
    await service.close()


async def test_store_session_fail_open_swallows(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/capture")
    service = make_service(url, fail_open=True)
    session = make_session(pairs=1)

    await service.store_session(session)  # must not raise
    # watermark NOT advanced → the delta will be retried next call
    assert service._captured_counts.get("s-1") is None
    await service.close()


async def test_store_session_fail_closed_raises(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/capture")
    service = make_service(url, fail_open=False)
    session = make_session(pairs=1)

    with pytest.raises(Exception, match="500"):
        await service.store_session(session)
    await service.close()


async def test_store_session_skips_when_disabled(fake_gw):
    from trpc_agent_sdk.abc import MemoryServiceConfig

    gw, url = fake_gw
    service = TencentDBMemoryService(
        TDAiConfig(gateway_url=url),
        memory_service_config=MemoryServiceConfig(enabled=False),
    )
    assert service.enabled is False
    await service.store_session(make_session(pairs=1))
    assert gw.payloads("/capture") == []
    await service.close()


async def test_store_session_no_session_id_is_noop(fake_gw):
    from trpc_agent_sdk.sessions import Session

    gw, url = fake_gw
    service = make_service(url)
    session = Session(id="", app_name="a", user_id="u", save_key="a/u", events=[])
    await service.store_session(session)
    assert gw.payloads("/capture") == []
    await service.close()


async def test_search_memory_maps_results(fake_gw):
    gw, url = fake_gw
    service = make_service(url)

    response = await service.search_memory("app/user", "project codename", limit=5)

    assert len(response.memories) == 1
    entry = response.memories[0]
    assert "Apollo Lake" in entry.content.parts[0].text
    assert entry.author == "tencentdb-memory"
    assert entry.timestamp  # ISO string forwarded to the LLM
    payload = gw.payloads("/search/memories")[0]
    assert payload == {"query": "project codename", "limit": 5, "user_id": "user"}
    await service.close()


async def test_search_memory_empty_results(fake_gw):
    gw, url = fake_gw
    gw.search_results = ""
    service = make_service(url)

    response = await service.search_memory("app/user", "nothing")
    assert response.memories == []
    await service.close()


async def test_search_memory_fail_open_returns_empty(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/search/memories")
    service = make_service(url, fail_open=True)

    response = await service.search_memory("app/user", "q")
    assert response.memories == []
    await service.close()


async def test_search_memory_fail_closed_raises(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/search/memories")
    service = make_service(url, fail_open=False)

    with pytest.raises(Exception, match="500"):
        await service.search_memory("app/user", "q")
    await service.close()


async def test_save_key_fallback_to_config_identity(fake_gw):
    gw, url = fake_gw
    service = make_service(url, app_name="cfg-app", user_id="cfg-user")

    await service.search_memory("", "q")  # empty key → config fallback
    payload = gw.payloads("/search/memories")[0]
    assert payload["user_id"] == "cfg-user"
    await service.close()


async def test_end_session_flushes(fake_gw):
    gw, url = fake_gw
    service = make_service(url)
    session = make_session()

    assert await service.end_session(session) is True
    payload = gw.payloads("/session/end")[0]
    assert payload["user_id"] == "user"
    await service.close()


async def test_end_session_fail_open_returns_false(fake_gw):
    gw, url = fake_gw
    gw.fail_routes.add("/session/end")
    service = make_service(url, fail_open=True)

    assert await service.end_session(make_session()) is False
    await service.close()


async def test_runner_integration_shape(fake_gw):
    """The service satisfies the framework call sites used by Runner.

    runners.py: ``if self.memory_service and self.memory_service.enabled:
    await self.memory_service.store_session(session, agent_context=...)``
    and invocation_context.py: ``await self.memory_service.search_memory(key,
    query, limit, agent_context=...)``.
    """
    from trpc_agent_sdk.abc import MemoryServiceABC

    gw, url = fake_gw
    service = make_service(url)
    assert isinstance(service, MemoryServiceABC)

    await service.store_session(make_session(), agent_context=None)
    await service.search_memory("app/user", "codename", limit=3, agent_context=None)
    assert len(gw.payloads("/capture")) == 1
    assert len(gw.payloads("/search/memories")) == 1
    await service.close()
