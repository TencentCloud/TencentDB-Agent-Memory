# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.12,<2", "python-dotenv>=1,<2"]
# ///
"""Run with: uv run agents/test-memory-mcp.py"""
import asyncio
import importlib.util
from pathlib import Path
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("memory_mcp", Path(__file__).with_name("memory_mcp.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


async def check():
    client = Mock()
    client.search_atomic.return_value = {"items": []}
    client.search_conversation.return_value = {"items": [{"content": "project note"}]}
    client.add_conversation.return_value = {"accepted_ids": ["note-1"]}
    server = module.create_server(client)
    await server.call_tool("memory_search", {"query": "project", "limit": 3})
    client.search_atomic.assert_called_once_with("project", limit=3)
    client.search_conversation.assert_called_once_with("project", limit=3)
    await server.call_tool("memory_save", {"note": "project note", "session_id": "codex:test"})
    client.add_conversation.assert_called_once_with(
        messages=[{"role": "user", "content": "project note"}], session_id="codex:test",
    )
    for name, args in [
        ("memory_search", {"query": "project", "limit": 0}),
        ("memory_save", {"note": "", "session_id": "codex:test"}),
        ("memory_save", {"note": "project note", "session_id": ""}),
    ]:
        try:
            await server.call_tool(name, args)
        except Exception:
            pass
        else:
            raise AssertionError(f"{name} accepted invalid input")
    assert client.add_conversation.call_count == 1
    assert client.search_atomic.call_count == 1
    print("PASS: shared search, save routing, and input validation")


asyncio.run(check())
