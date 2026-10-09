from __future__ import annotations

import json
import os
import urllib.request
from typing import Any

from fastmcp import FastMCP


mcp = FastMCP("tdai-openhands-search")


@mcp.tool()
def tdai_memory_search(query: str, limit: int | None = None) -> str:
    """Search TencentDB Agent Memory for durable L1/L2/L3 memories."""
    return _post(
        "/search/memories",
        {
            "query": query,
            "limit": limit or int(os.getenv("TDAI_MEMORY_SEARCH_LIMIT", "5")),
        },
    )


@mcp.tool()
def tdai_conversation_search(
    query: str,
    limit: int | None = None,
    session_key: str | None = None,
) -> str:
    """Search raw conversation records captured by TencentDB Agent Memory."""
    payload: dict[str, Any] = {
        "query": query,
        "limit": limit or int(os.getenv("TDAI_CONVERSATION_SEARCH_LIMIT", "5")),
    }
    configured_session = session_key or os.getenv("TDAI_SESSION_KEY")
    if configured_session:
        payload["session_key"] = configured_session
    return _post("/search/conversations", payload)


def _post(path: str, payload: dict[str, Any]) -> str:
    base_url = os.getenv("TDAI_GATEWAY_URL", "http://127.0.0.1:8420").rstrip("/")
    timeout = float(os.getenv("TDAI_GATEWAY_TIMEOUT", "8"))
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    api_key = os.getenv(
        os.getenv("TDAI_GATEWAY_API_KEY_ENV", "TDAI_GATEWAY_API_KEY")
    )
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        text = response.read().decode("utf-8")
    return text or "{}"


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
