from __future__ import annotations

from pathlib import Path
import sys

from .client import MemorySearchResult, RecallResult
from .config import GatewayConfig, RecallConfig, ToolConfig
from .utils import strip_memory_tool_guide, truncate_text


def compose_recall_context(
    *,
    recall: RecallResult | None,
    l1_search: MemorySearchResult | None,
    config: RecallConfig,
    tool_bundle_enabled: bool = False,
) -> str:
    parts: list[str] = []
    if l1_search and l1_search.results.strip():
        parts.append(
            "<relevant-memories>\n"
            "The following durable memories were retrieved for this OpenHands request. "
            "Use them as background only and verify task-specific facts in the current workspace.\n\n"
            f"{l1_search.results.strip()}\n"
            "</relevant-memories>"
        )
    if recall and recall.context.strip():
        context = recall.context.strip()
        if config.strip_tool_guide_if_no_tool_bundle and not tool_bundle_enabled:
            context = strip_memory_tool_guide(context)
        parts.append(context)
    body = "\n\n".join(part for part in parts if part.strip()).strip()
    if not body:
        return ""
    wrapped = (
        "<tdai_recall_context>\n"
        "TencentDB Agent Memory recalled the following context before this OpenHands turn. "
        "Use it only as background. The current request, workspace contents, and executable evidence remain authoritative.\n\n"
        f"{body}\n"
        "</tdai_recall_context>"
    )
    return truncate_text(wrapped, config.max_context_chars, marker="[tdai] Recall context truncated.")
def build_tdai_mcp_server_config(
    *,
    gateway: GatewayConfig,
    tools: ToolConfig,
) -> dict[str, Any]:
    adapter_root = Path(__file__).resolve().parents[1]
    server_script = (
        Path(tools.server_script).expanduser()
        if tools.server_script
        else adapter_root / "tools" / "tdai_search" / "tdai_mcp_server.py"
    )
    env = {
        "TDAI_GATEWAY_URL": tools.gateway_url or gateway.url,
        "TDAI_GATEWAY_API_KEY_ENV": tools.api_key_env or gateway.api_key_env,
        "TDAI_MEMORY_SEARCH_LIMIT": str(tools.memory_search_limit),
        "TDAI_CONVERSATION_SEARCH_LIMIT": str(tools.conversation_search_limit),
    }
    return {
        "command": tools.command or sys.executable,
        "args": [str(server_script)],
        "env": env,
    }
