from __future__ import annotations

import importlib
import socket

import pytest

from conftest import GatewayStub


async def test_recall_maps_request_and_bearer_auth(
    gateway_stub: GatewayStub,
) -> None:
    """Break caught: recall using the wrong route, payload, or auth header."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")
    gateway_stub.responses.put(
        (200, {"context": "remembered"}, "application/json")
    )
    client = client_class(
        gateway_stub.base_url,
        timeout=1,
        api_key="  secret-token  ",
    )

    result = await client.recall("where is it?", "session-1", "user-7")

    request = gateway_stub.requests.get_nowait()
    assert result == {"context": "remembered"}
    assert request.method == "POST"
    assert request.path == "/recall"
    assert request.headers["Authorization"] == "Bearer secret-token"
    assert request.body == {
        "query": "where is it?",
        "session_key": "session-1",
        "user_id": "user-7",
    }


async def test_health_uses_get_without_authorization(
    gateway_stub: GatewayStub,
) -> None:
    """Break caught: health using a body, wrong verb, or empty auth header."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")
    gateway_stub.responses.put((200, {"status": "ok"}, "application/json"))

    result = await client_class(gateway_stub.base_url, api_key=" ").health()

    request = gateway_stub.requests.get_nowait()
    assert result == {"status": "ok"}
    assert request.method == "GET"
    assert request.path == "/health"
    assert request.body is None
    assert "Authorization" not in request.headers


@pytest.mark.parametrize(
    ("method_name", "args", "expected_path", "expected_body"),
    [
        (
            "capture",
            ("hello", "hi", "session-1", "gateway-session-1", "user-7"),
            "/capture",
            {
                "user_content": "hello",
                "assistant_content": "hi",
                "session_key": "session-1",
                "session_id": "gateway-session-1",
                "user_id": "user-7",
            },
        ),
        (
            "search_memories",
            ("database", 3, "preference", "coding"),
            "/search/memories",
            {
                "query": "database",
                "limit": 3,
                "type": "preference",
                "scene": "coding",
            },
        ),
        (
            "search_conversations",
            ("database", 4, "session-1"),
            "/search/conversations",
            {
                "query": "database",
                "limit": 4,
                "session_key": "session-1",
            },
        ),
        (
            "end_session",
            ("session-1", "user-7"),
            "/session/end",
            {"session_key": "session-1", "user_id": "user-7"},
        ),
    ],
)
async def test_post_routes_map_arguments(
    gateway_stub: GatewayStub,
    method_name: str,
    args: tuple[object, ...],
    expected_path: str,
    expected_body: dict[str, object],
) -> None:
    """Break caught: public methods drifting from Gateway route contracts."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")
    gateway_stub.responses.put((200, {"ok": True}, "application/json"))
    client = client_class(gateway_stub.base_url)

    result = await getattr(client, method_name)(*args)

    request = gateway_stub.requests.get_nowait()
    assert result == {"ok": True}
    assert request.method == "POST"
    assert request.path == expected_path
    assert request.body == expected_body


async def test_optional_fields_are_omitted(gateway_stub: GatewayStub) -> None:
    """Break caught: empty optional values being serialized as meaningful data."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")
    gateway_stub.responses.put((200, {"ok": True}, "application/json"))

    await client_class(gateway_stub.base_url).capture("hello", "hi", "session-1")

    assert gateway_stub.requests.get_nowait().body == {
        "user_content": "hello",
        "assistant_content": "hi",
        "session_key": "session-1",
    }


async def test_http_error_is_structured_and_does_not_leak_key(
    gateway_stub: GatewayStub,
) -> None:
    """Break caught: HTTP failures exposing credentials or losing route/status."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")
    error_class = getattr(client_module, "TdaiGatewayError")
    gateway_stub.responses.put(
        (401, {"error": "unauthorized"}, "application/json")
    )
    client = client_class(gateway_stub.base_url, api_key="secret-token")

    with pytest.raises(error_class) as caught:
        await client.recall("query", "session-1")

    assert caught.value.path == "/recall"
    assert caught.value.status == 401
    assert "/recall" in str(caught.value)
    assert "401" in str(caught.value)
    assert "secret-token" not in str(caught.value)


@pytest.mark.parametrize(
    "payload",
    [
        b"{not-json",
        ["unexpected", "list"],
    ],
)
async def test_invalid_json_shapes_raise_gateway_error(
    gateway_stub: GatewayStub,
    payload: object,
) -> None:
    """Break caught: malformed or non-object responses reaching callers."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")
    error_class = getattr(client_module, "TdaiGatewayError")
    gateway_stub.responses.put((200, payload, "application/json"))

    with pytest.raises(error_class):
        await client_class(gateway_stub.base_url).health()


async def test_refused_connection_is_safe_gateway_error() -> None:
    """Break caught: transport internals, URLs, or credentials leaking to users."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")
    error_class = getattr(client_module, "TdaiGatewayError")
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    host, port = probe.getsockname()
    probe.close()
    client = client_class(
        f"http://{host}:{port}",
        timeout=0.2,
        api_key="secret-token",
    )

    with pytest.raises(error_class) as caught:
        await client.health()

    assert caught.value.status is None
    assert str(port) not in str(caught.value)
    assert "secret-token" not in str(caught.value)


async def test_short_timeout_becomes_gateway_error(
    gateway_stub: GatewayStub,
) -> None:
    """Break caught: timeouts escaping as raw urllib or socket exceptions."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")
    error_class = getattr(client_module, "TdaiGatewayError")
    gateway_stub.responses.put(
        (200, {"status": "ok"}, "application/json", 0.2)
    )

    with pytest.raises(error_class):
        await client_class(gateway_stub.base_url, timeout=0.01).health()


def test_non_positive_timeout_is_rejected() -> None:
    """Break caught: a zero timeout being deferred to confusing socket errors."""
    client_module = importlib.import_module("tdai_pydantic_ai.client")
    client_class = getattr(client_module, "TdaiGatewayClient")

    with pytest.raises(ValueError, match="greater than zero"):
        client_class(timeout=0)


def test_client_api_is_exported_from_package_root() -> None:
    """Break caught: documented imports disappearing from the public package."""
    package = importlib.import_module("tdai_pydantic_ai")

    assert package.__all__ == [
        "GatewayClientProtocol",
        "TdaiGatewayClient",
        "TdaiGatewayError",
    ]
    assert package.TdaiGatewayClient.__name__ == "TdaiGatewayClient"
