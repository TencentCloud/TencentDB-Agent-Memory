import os
from pathlib import Path

import pytest

from tdai_memory_mcp.config import load_config
from tdai_memory_mcp.protocol import McpServer
from tdai_memory_mcp.side_channel import run_side_channel


pytestmark = pytest.mark.skipif(os.environ.get("TDAI_MCP_E2E") != "1", reason="set TDAI_MCP_E2E=1 to run real Gateway e2e")


def test_real_adapter_path_with_gateway_ollama():
    env = {
        **os.environ,
        "TDAI_GATEWAY_URL": os.environ.get("TDAI_GATEWAY_URL") or "http://127.0.0.1:8420",
        "TDAI_REQUEST_TIMEOUT_MS": os.environ.get("TDAI_REQUEST_TIMEOUT_MS") or "120000",
    }

    health = run_side_channel(["health"], env=env)
    assert health["code"] == 0, health.get("stderr")
    assert "status: ok" in health["stdout"] or "status: degraded" in health["stdout"]

    config = load_config(env, str(Path.cwd()))
    server = McpServer(config=config)
    conversation_search = server.handle_message({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "tdai_conversation_search",
            "arguments": {
                "query": "MCP 测试",
                "session_key": os.environ.get("TDAI_SESSION_KEY") or "agent:mcp-e2e",
                "limit": 5,
            },
        },
    })
    assert "error" not in conversation_search
    assert "TDAI Conversation Search" in conversation_search["result"]["content"][0]["text"]
