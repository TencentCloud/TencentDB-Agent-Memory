import asyncio
from typing import Any, Dict, List, Optional, Tuple

from tencentdb_agent_memory.v3.skill_client import (
    AsyncSkillClient,
    SkillClient,
)


class RecordingStub:
    def __init__(self) -> None:
        self.calls: List[Tuple[str, Dict[str, Any]]] = []

    def post(
        self,
        path: str,
        body: Dict[str, Any],
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        self.calls.append((path, body))
        return {}

    def close(self) -> None:
        return None


class AsyncRecordingStub:
    def __init__(self) -> None:
        self.calls: List[Tuple[str, Dict[str, Any]]] = []

    async def post(
        self,
        path: str,
        body: Dict[str, Any],
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        self.calls.append((path, body))
        return {}

    async def close(self) -> None:
        return None


def test_sync_with_defaults_distinguishes_omitted_from_none() -> None:
    stub = RecordingStub()
    client = SkillClient(
        stub=stub,
        team_id="team-1",
        agent_id="agent-1",
        user_id="user-1",
        task_id="task-1",
    )

    client.with_defaults().list()
    client.with_defaults(team_id=None, task_id=None).list()

    assert stub.calls[0] == (
        "/v3/skill/list",
        {
            "team_id": "team-1",
            "agent_id": "agent-1",
            "user_id": "user-1",
            "task_id": "task-1",
        },
    )
    assert stub.calls[1] == (
        "/v3/skill/list",
        {
            "agent_id": "agent-1",
            "user_id": "user-1",
        },
    )


def test_async_with_defaults_distinguishes_omitted_from_none() -> None:
    stub = AsyncRecordingStub()
    client = AsyncSkillClient(
        stub=stub,
        team_id="team-1",
        agent_id="agent-1",
        user_id="user-1",
        task_id="task-1",
    )

    async def run() -> None:
        await client.with_defaults().list()
        await client.with_defaults(agent_id=None, task_id=None).list()

    asyncio.run(run())

    assert stub.calls[0] == (
        "/v3/skill/list",
        {
            "team_id": "team-1",
            "agent_id": "agent-1",
            "user_id": "user-1",
            "task_id": "task-1",
        },
    )
    assert stub.calls[1] == (
        "/v3/skill/list",
        {
            "team_id": "team-1",
            "user_id": "user-1",
        },
    )
