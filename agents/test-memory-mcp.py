# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.12,<2", "python-dotenv>=1,<2"]
# ///
"""Run with: uv run agents/test-memory-mcp.py"""
import asyncio
import importlib.util
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("memory_mcp", Path(__file__).with_name("memory_mcp.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

client = Mock()
client.search_atomic.return_value = {"items": []}
client.search_conversation.return_value = {"items": [{"content": "project note"}]}
client.add_conversation.return_value = {"accepted_ids": ["note-1"]}
client.read_core.return_value = {"content": "profile"}
client.list_scenarios.return_value = {"entries": []}
client.read_scenario.return_value = {"content": "scenario"}
opened = []


@contextmanager
def fake_session_client(session_id):
    """Stand in for the sqlite-backed scope lookup; record which session was resolved."""
    if session_id == "codex:unknown":
        raise ValueError("Unknown memory session")
    opened.append(session_id)
    yield client, f"{session_id}:memory:deadbeef"


module.session_client = fake_session_client


async def check():
    server = module.create_server()
    await server.call_tool("memory_search", {"query": "project", "limit": 3, "session_id": "codex:test"})
    client.search_atomic.assert_called_once_with("project", limit=3)
    client.search_conversation.assert_called_once_with("project", limit=3)

    await server.call_tool("memory_save", {"note": "project note", "session_id": "codex:test"})
    client.add_conversation.assert_called_once_with(
        messages=[{"role": "user", "content": "project note"}],
        session_id="codex:test:memory:deadbeef",
    )

    await server.call_tool("memory_profile", {"session_id": "codex:test"})
    client.read_core.assert_called_once()
    await server.call_tool("memory_scenario", {"path": "a.md", "session_id": "codex:test"})
    client.read_scenario.assert_called_once_with("a.md")
    assert opened == ["codex:test"] * 4, opened

    # Every tool needs a session; none may fall back to a global agent.
    for name, args in [
        ("memory_search", {"query": "project", "limit": 3}),
        ("memory_save", {"note": "project note"}),
        ("memory_profile", {}),
        ("memory_scenario", {"path": "a.md"}),
        ("memory_search", {"query": "project", "limit": 0, "session_id": "codex:test"}),
        ("memory_save", {"note": "", "session_id": "codex:test"}),
        ("memory_save", {"note": "project note", "session_id": ""}),
        ("memory_save", {"note": "project note", "session_id": "codex:unknown"}),
    ]:
        try:
            await server.call_tool(name, args)
        except Exception:
            pass
        else:
            raise AssertionError(f"{name} accepted invalid input: {args}")
    assert client.add_conversation.call_count == 1
    assert client.search_atomic.call_count == 1
    print("PASS: session-scoped search, save, profile, scenario, and input validation")


asyncio.run(check())
