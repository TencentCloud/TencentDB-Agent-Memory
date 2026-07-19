from tdai_openhands.client import MemorySearchResult, RecallResult
from tdai_openhands.config import GatewayConfig, RecallConfig, ToolConfig
from tdai_openhands.prompt import (
    build_tdai_mcp_server_config,
    compose_recall_context,
)


def test_compose_recall_context_combines_l1_and_recall() -> None:
    context = compose_recall_context(
        recall=RecallResult(context="scene memory"),
        l1_search=MemorySearchResult(results="l1 memory", total=1),
        config=RecallConfig(max_context_chars=2000),
    )
    assert "<tdai_recall_context>" in context
    assert "<relevant-memories>" in context
    assert "l1 memory" in context
    assert "scene memory" in context


def test_build_tdai_mcp_server_config() -> None:
    server = build_tdai_mcp_server_config(
        gateway=GatewayConfig(url="http://127.0.0.1:8420"),
        tools=ToolConfig(enabled=True, command="python", memory_search_limit=2),
    )
    assert server["command"] == "python"
    assert server["env"]["TDAI_GATEWAY_URL"] == "http://127.0.0.1:8420"
    assert server["env"]["TDAI_MEMORY_SEARCH_LIMIT"] == "2"
    assert server["args"][0].endswith("tdai_mcp_server.py")
