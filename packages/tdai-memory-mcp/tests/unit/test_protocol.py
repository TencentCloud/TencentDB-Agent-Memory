import io
import json

from tdai_memory_mcp.config import load_config
from tdai_memory_mcp.protocol import McpServer, encode_frame, parse_next_message


class FakeClient:
    def __init__(self):
        self.called = False

    def search_memories(self, **_kwargs):
        self.called = True
        return {"results": "memory result", "total": 1, "strategy": "hybrid"}


def make_server():
    config = load_config({"TDAI_GATEWAY_URL": "http://127.0.0.1:8420"}, "/tmp/repo")
    client = FakeClient()
    return McpServer(config=config, client=client), client


def test_initialize_returns_capabilities():
    server, _ = make_server()
    response = server.handle_message({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2024-11-05"},
    })

    assert response["result"]["serverInfo"]["name"] == "tdai-memory-mcp"
    assert response["result"]["capabilities"] == {"tools": {}}


def test_tools_list_exposes_search_tools():
    server, _ = make_server()
    response = server.handle_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})

    assert [tool["name"] for tool in response["result"]["tools"]] == [
        "tdai_memory_search",
        "tdai_conversation_search",
    ]


def test_tools_call_dispatches_to_gateway_transport():
    server, client = make_server()
    response = server.handle_message({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {"name": "tdai_memory_search", "arguments": {"query": "q"}},
    })

    assert client.called is True
    assert "memory result" in response["result"]["content"][0]["text"]


def test_content_length_frame_round_trip():
    message = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    parsed, rest = parse_next_message(encode_frame(message))

    assert rest == b""
    assert parsed.framed is True
    assert json.loads(parsed.body) == message


def test_line_delimited_message_round_trip():
    message = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    parsed, rest = parse_next_message(json.dumps(message).encode() + b"\n")

    assert rest == b""
    assert parsed.framed is False
    assert json.loads(parsed.body) == message


def test_serve_handles_framed_tools_list():
    server, _ = make_server()
    inp = io.BytesIO(encode_frame({"jsonrpc": "2.0", "id": 9, "method": "tools/list"}))
    out = io.BytesIO()

    server.serve(inp, out)
    parsed, _ = parse_next_message(out.getvalue())
    response = json.loads(parsed.body)

    assert response["id"] == 9
    assert response["result"]["tools"][0]["name"] == "tdai_memory_search"
