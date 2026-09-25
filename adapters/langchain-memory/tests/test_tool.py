from __future__ import annotations

import asyncio

from tencentdb_langchain import (
    create_async_memory_search_tool,
    create_memory_search_tool,
)

from conftest import FACT, build_async_memory, build_sync_memory


def test_search_tool_formats_facts():
    memory = build_sync_memory({"/v3/atomic/search": {"items": [FACT]}})
    tool = create_memory_search_tool(memory)
    output = tool.invoke({"query": "theme"})
    assert "The user prefers dark theme" in output
    assert "[preference]" in output


def test_search_tool_reports_no_hits():
    memory = build_sync_memory({"/v3/atomic/search": {"items": []}})
    tool = create_memory_search_tool(memory)
    output = tool.invoke({"query": "nothing"})
    assert "No relevant memories found" in output


def test_async_search_tool_formats_facts():
    memory = build_async_memory({"/v3/atomic/search": {"items": [FACT]}})
    tool = create_async_memory_search_tool(memory)
    output = asyncio.run(tool.ainvoke({"query": "theme"}))
    assert "The user prefers dark theme" in output
