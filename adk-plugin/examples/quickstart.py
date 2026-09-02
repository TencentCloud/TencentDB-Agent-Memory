"""End-to-end smoke test for the ADK adapter against a live Gateway.

Exercises capture → conversation search → session end without any LLM
key (L0 write and raw search work without the extraction pipeline).

Prerequisites:
    # from the repository root
    pnpm exec tsx src/gateway/server.ts        # terminal 1
    pip install google-adk                     # terminal 2
    PYTHONPATH=adk-plugin python adk-plugin/examples/quickstart.py

Environment:
    TDAI_GATEWAY_URL — Gateway base URL (default http://127.0.0.1:8420)
"""

from __future__ import annotations

import asyncio
import sys
import time

from google.adk.events.event import Event
from google.adk.sessions.session import Session
from google.genai import types

from memory_tencentdb_adk import TdaiMemoryService


def _event(author: str, text: str, seq: int) -> Event:
    return Event(
        id=f"quickstart-{seq}",
        invocation_id=f"quickstart-inv-{seq}",
        author=author,
        content=types.Content(
            role="user" if author == "user" else "model",
            parts=[types.Part(text=text)],
        ),
    )


async def main() -> int:
    service = TdaiMemoryService(strict=True)
    if not service.client.is_healthy():
        print(f"Gateway not reachable at {service.client.base_url} — start it first.")
        return 1
    print(f"Gateway healthy at {service.client.base_url}")

    marker = f"quickstart-{int(time.time())}"
    session = Session(
        id=marker,
        app_name="adk-quickstart",
        user_id="demo-user",
        events=[
            _event("user", f"Remember this token for me: {marker}", 1),
            _event("assistant", f"Got it — I will remember {marker}.", 2),
        ],
    )

    await service.add_session_to_memory(session)
    print("capture: ok (1 turn)")

    response = await service.search_memory(
        app_name="adk-quickstart", user_id="demo-user", query=marker
    )
    hit = any(
        marker in (part.text or "")
        for entry in response.memories
        for part in (entry.content.parts or [])
    )
    print(f"search: {len(response.memories)} entr(y/ies), marker found: {hit}")

    await service.end_session(
        app_name="adk-quickstart", user_id="demo-user", session_id=marker
    )
    print("session end: ok")
    return 0 if hit else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
