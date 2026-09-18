from __future__ import annotations

import asyncio
from dataclasses import replace

import httpx2
import pytest

from tencentdb_memory_openai_agents import (
    MemoryProxyConfig,
    create_openai_client,
    create_openai_model,
)


def config(**overrides: str) -> MemoryProxyConfig:
    base = MemoryProxyConfig(
        proxy_url="https://memory.example.com/proxy/",
        user_key="memory-user-key",
        team_id="team-1",
        agent_id="agent-1",
        task_id="task-1",
        conversation_id="conversation-1",
        model="gpt-4.1-mini",
        space_id="default",
    )
    return replace(base, **overrides)


def test_from_env_requires_every_identity_value() -> None:
    with pytest.raises(ValueError, match="TDAI_CONVERSATION_ID"):
        MemoryProxyConfig.from_env(
            {
                "TDAI_MEMORY_PROXY_URL": "https://memory.example.com",
                "TDAI_MEMORY_USER_KEY": "key",
                "TDAI_TEAM_ID": "team",
                "TDAI_AGENT_ID": "agent",
                "TDAI_TASK_ID": "task",
            }
        )


@pytest.mark.parametrize(
    "proxy_url",
    [
        "http://memory.example.com",
        "ftp://memory.example.com",
        "https://user:pass@memory.example.com",
        "https://memory.example.com?token=secret",
    ],
)
def test_rejects_unsafe_proxy_urls(proxy_url: str) -> None:
    with pytest.raises(ValueError):
        config(proxy_url=proxy_url)


@pytest.mark.parametrize(
    "proxy_url",
    ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"],
)
def test_allows_plain_http_only_for_loopback(proxy_url: str) -> None:
    assert config(proxy_url=proxy_url).proxy_url == proxy_url


def test_rejects_header_injection() -> None:
    with pytest.raises(ValueError, match="line breaks"):
        config(task_id="task-1\r\nx-extra: injected")


def test_config_repr_does_not_expose_user_key() -> None:
    assert "memory-user-key" not in repr(config())


def test_model_uses_explicit_client() -> None:
    async def create_once() -> str:
        client = create_openai_client(config())
        try:
            return type(create_openai_model(config(), client=client)).__name__
        finally:
            await client.close()

    assert asyncio.run(create_once()) == "OpenAIChatCompletionsModel"


def test_openai_client_sends_memory_proxy_path_and_identity_headers() -> None:
    captured: dict[str, object] = {}

    def handle(request: httpx2.Request) -> httpx2.Response:
        captured["path"] = request.url.path
        captured["headers"] = request.headers
        return httpx2.Response(
            200,
            json={
                "id": "chatcmpl-test",
                "object": "chat.completion",
                "created": 0,
                "model": "gpt-4.1-mini",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "ok"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            },
        )

    async def request_once() -> str:
        transport = httpx2.MockTransport(handle)
        http_client = httpx2.AsyncClient(transport=transport)
        client = create_openai_client(config(), http_client=http_client)
        try:
            response = await client.chat.completions.create(
                model="gpt-4.1-mini",
                messages=[{"role": "user", "content": "hello"}],
            )
            return response.choices[0].message.content or ""
        finally:
            await client.close()

    assert asyncio.run(request_once()) == "ok"
    assert captured["path"] == "/proxy/codebuddy/default/v1/chat/completions"
    headers = captured["headers"]
    assert isinstance(headers, httpx2.Headers)
    assert headers["authorization"] == "Bearer memory-user-key"
    assert headers["x-team-id"] == "team-1"
    assert headers["x-agent-id"] == "agent-1"
    assert headers["x-task-id"] == "task-1"
    assert headers["x-conversation-id"] == "conversation-1"
