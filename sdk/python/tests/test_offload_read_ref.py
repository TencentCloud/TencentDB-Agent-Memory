from typing import Any, Dict, Optional

import pytest

from tencentdb_agent_memory import AsyncMemoryClient, MemoryClient
from tencentdb_agent_memory._http import Stub


class RecordingStub(Stub):
    def __init__(self) -> None:
        self.path = ""
        self.body: Dict[str, Any] = {}

    def post(
        self,
        path: str,
        body: dict,
        timeout: Optional[float] = None,
    ) -> dict:
        self.path = path
        self.body = body
        return {"content": "archived result", "truncated": False}

    def close(self) -> None:
        pass


class AsyncRecordingStub:
    def __init__(self) -> None:
        self.path = ""
        self.body: Dict[str, Any] = {}

    async def post(
        self,
        path: str,
        body: dict,
        timeout: Optional[float] = None,
    ) -> dict:
        self.path = path
        self.body = body
        return {"content": "archived result", "truncated": False}


def test_offload_read_ref_posts_bounded_query_options() -> None:
    stub = RecordingStub()
    client = MemoryClient(stub=stub)

    result = client.offload_read_ref(
        "session-1",
        "offload/session-1/refs/call-1.md",
        query="needle",
        max_tokens=800,
    )

    assert stub.path == "/v2/offload/read-ref"
    assert stub.body == {
        "session_id": "session-1",
        "result_ref": "offload/session-1/refs/call-1.md",
        "query": "needle",
        "max_tokens": 800,
    }
    assert result["content"] == "archived result"


@pytest.mark.asyncio
async def test_async_offload_read_ref_posts_line_range() -> None:
    stub = AsyncRecordingStub()
    client = AsyncMemoryClient.__new__(AsyncMemoryClient)
    client._stub = stub

    result = await client.offload_read_ref(
        "session-1",
        "offload/session-1/refs/call-1.md",
        start_line=5,
        end_line=12,
    )

    assert stub.path == "/v2/offload/read-ref"
    assert stub.body == {
        "session_id": "session-1",
        "result_ref": "offload/session-1/refs/call-1.md",
        "start_line": 5,
        "end_line": 12,
    }
    assert result["content"] == "archived result"
