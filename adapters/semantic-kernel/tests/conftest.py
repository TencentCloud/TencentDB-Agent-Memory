"""Shared fixtures: a fake memory-core gateway (aiohttp) for smoke tests."""

from __future__ import annotations

from typing import Any

import pytest


class FakeGateway:
    """Records requests and replies with contract-shaped responses.

    Toggle ``fail_routes`` to simulate gateway errors for specific paths.
    """

    def __init__(self) -> None:
        from aiohttp import web

        self.requests: list[tuple[str, str, dict[str, Any] | None]] = []
        self.recall_context = "User's project codename is Apollo Lake."
        self.fail_routes: set[str] = set()
        self.app = web.Application()
        self.app.router.add_get("/health", self._health)
        self.app.router.add_post("/capture", self._capture)
        self.app.router.add_post("/recall", self._recall)
        self.app.router.add_post("/search/memories", self._search_memories)
        self.app.router.add_post("/search/conversations", self._search_conversations)
        self.app.router.add_post("/session/end", self._session_end)
        self.runner: Any = None

    async def start(self) -> str:
        from aiohttp import web

        self.runner = web.AppRunner(self.app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = self.runner.addresses[0][1]
        return f"http://127.0.0.1:{port}"

    async def stop(self) -> None:
        if self.runner:
            await self.runner.cleanup()

    def payloads(self, path: str) -> list[dict[str, Any]]:
        return [b for p, _, b in self.requests if p == path and b is not None]

    def _record(self, request, body: dict[str, Any] | None = None) -> None:
        self.requests.append((request.path, request.headers.get("Authorization", ""), body))

    async def _reply(self, request, payload: dict[str, Any]):
        from aiohttp import web

        if request.path in self.fail_routes:
            return web.json_response({"error": "simulated failure"}, status=500)
        return web.json_response(payload)

    async def _health(self, request):
        self._record(request)
        return await self._reply(request, {"status": "ok", "version": "test-gateway"})

    async def _capture(self, request):
        body = await request.json()
        self._record(request, body)
        return await self._reply(
            request,
            {"l0_recorded": len(body.get("messages", [])), "scheduler_notified": True},
        )

    async def _recall(self, request):
        body = await request.json()
        self._record(request, body)
        return await self._reply(
            request,
            {"context": self.recall_context, "strategy": "semantic", "memory_count": 1},
        )

    async def _search_memories(self, request):
        body = await request.json()
        self._record(request, body)
        return await self._reply(
            request, {"results": "[mem] codename=Apollo Lake", "total": 1, "strategy": "semantic"}
        )

    async def _search_conversations(self, request):
        body = await request.json()
        self._record(request, body)
        return await self._reply(request, {"results": "[conv] user asked about codename", "total": 1})

    async def _session_end(self, request):
        body = await request.json()
        self._record(request, body)
        return await self._reply(request, {"flushed": True})


@pytest.fixture
async def fake_gw():
    gw = FakeGateway()
    url = await gw.start()
    yield gw, url
    await gw.stop()
