from tdai_memory_mcp.tools import TOOLS, call_tool


class FakeClient:
    def __init__(self):
        self.calls = []

    def search_memories(self, **kwargs):
        self.calls.append(("search_memories", kwargs))
        return {"results": "memory", "total": 1, "strategy": "fts"}

    def search_conversations(self, **kwargs):
        self.calls.append(("search_conversations", kwargs))
        return {"results": "conversation", "total": 1}


def test_tools_list_only_exposes_search_tools():
    assert [tool["name"] for tool in TOOLS] == [
        "tdai_memory_search",
        "tdai_conversation_search",
    ]


def test_memory_search_normalizes_limit():
    client = FakeClient()
    result = call_tool("tdai_memory_search", {"query": "q", "limit": 999}, client)

    assert "isError" not in result
    assert client.calls[0] == ("search_memories", {
        "query": "q",
        "limit": 50,
        "type_filter": "",
        "scene": "",
    })


def test_conversation_search_forwards_session_filter():
    client = FakeClient()
    result = call_tool(
        "tdai_conversation_search",
        {"query": "q", "session_key": "session:1", "limit": 3},
        client,
    )

    assert "isError" not in result
    assert client.calls[0] == ("search_conversations", {
        "query": "q",
        "limit": 3,
        "session_key": "session:1",
    })
    assert "conversation" in result["content"][0]["text"]


def test_lifecycle_commands_are_not_mcp_tools():
    client = FakeClient()
    for name in ["tdai_health", "tdai_memory_recall", "tdai_memory_capture", "tdai_session_end"]:
        result = call_tool(name, {}, client)
        assert result["isError"] is True
        assert "Unknown tool" in result["content"][0]["text"]
