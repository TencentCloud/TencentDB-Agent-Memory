#!/usr/bin/env python3
"""TencentDB Agent Memory MCP server for Codex."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP


BASE = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420").rstrip("/")
DEFAULT_SESSION_KEY = os.environ.get("TDAI_SESSION_KEY") or str(Path.cwd())
TOKEN = os.environ.get("TDAI_GATEWAY_TOKEN")
TIMEOUT_SECONDS = float(os.environ.get("TDAI_GATEWAY_TIMEOUT", "30"))

mcp = FastMCP(
    "tdai-memory",
    instructions=(
        "Use tdai_recall before starting coding tasks when prior TencentDB "
        "Agent Memory context may help."
    ),
    log_level=os.environ.get("FASTMCP_LOG_LEVEL", "ERROR"),
)


async def post(path: str, body: dict[str, Any]) -> Any:
    headers = {"content-type": "application/json"}
    if TOKEN:
        headers["authorization"] = f"Bearer {TOKEN}"

    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.post(f"{BASE}{path}", headers=headers, json=body)

    text = response.text
    if response.status_code >= 400:
        raise RuntimeError(f"{path} failed: HTTP {response.status_code} {text}")

    if not text:
        return {}

    try:
        return response.json()
    except json.JSONDecodeError:
        return text


def pretty(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=2)


@mcp.tool(
    description="Recall relevant TencentDB Agent Memory context before starting a coding task.",
    structured_output=False,
)
async def tdai_recall(query: str, session_key: str | None = None) -> str:
    return pretty(
        await post(
            "/recall",
            {
                "query": query,
                "session_key": session_key or DEFAULT_SESSION_KEY,
            },
        )
    )


@mcp.tool(
    description="Search structured L1 memories.",
    structured_output=False,
)
async def tdai_memory_search(
    query: str,
    limit: int | None = None,
    type: str | None = None,
    scene: str | None = None,
) -> str:
    body: dict[str, Any] = {"query": query}
    if limit is not None:
        body["limit"] = limit
    if type is not None:
        body["type"] = type
    if scene is not None:
        body["scene"] = scene
    return pretty(await post("/search/memories", body))


@mcp.tool(
    description="Search raw L0 conversation history as evidence.",
    structured_output=False,
)
async def tdai_conversation_search(
    query: str,
    limit: int | None = None,
    session_key: str | None = None,
) -> str:
    body: dict[str, Any] = {
        "query": query,
        "session_key": session_key or DEFAULT_SESSION_KEY,
    }
    if limit is not None:
        body["limit"] = limit
    return pretty(await post("/search/conversations", body))


@mcp.tool(
    description="Store a concise user/assistant turn into TencentDB Agent Memory.",
    structured_output=False,
)
async def tdai_capture(
    user_content: str,
    assistant_content: str,
    session_key: str | None = None,
    session_id: str | None = None,
) -> str:
    body: dict[str, Any] = {
        "user_content": user_content,
        "assistant_content": assistant_content,
        "session_key": session_key or DEFAULT_SESSION_KEY,
    }
    if session_id is not None:
        body["session_id"] = session_id
    return pretty(await post("/capture", body))


@mcp.tool(
    description="Flush memory pipeline for the current session.",
    structured_output=False,
)
async def tdai_session_end(session_key: str | None = None) -> str:
    return pretty(
        await post(
            "/session/end",
            {
                "session_key": session_key or DEFAULT_SESSION_KEY,
            },
        )
    )


if __name__ == "__main__":
    mcp.run("stdio")
