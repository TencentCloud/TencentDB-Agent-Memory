"""
memory_tencentdb — Dify Plugin Provider.

Connects the Dify agent tool surface to TencentDB-Agent-Memory via the
standalone Gateway HTTP sidecar. Maps Dify tool calls to Gateway API
endpoints and reports results back as Dify tool response blobs.

Dify agents call:
    memory_tencentdb_memory_search       → Gateway POST /search/memories
    memory_tencentdb_conversation_search → Gateway POST /search/conversations

Additional lifecycle hooks (pre-message recall, post-message capture)
are wired through Dify's Provider interface when the host supports them.

Requires the standalone Gateway to be running. Start it with:
    npx memory-tencentdb-mcp    # MCP server (includes embedded Gateway logic)
    # or standalone:
    TDAI_LLM_API_KEY=sk-... npx tsx src/gateway/server.ts
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

from .client import MemoryTencentdbClient
from .tools import TOOL_DEFINITIONS

logger = logging.getLogger(__name__)

# ── Helpers ────────────────────────────────────────────────────────────

def _resolve_env_var(name: str, default: str = "") -> str:
    """Read an env var, stripping surrounding whitespace."""
    return (os.environ.get(name) or default).strip()


def _coerce_limit(raw: Any, default: int = 5, maximum: int = 20) -> int:
    """Coerce a tool-call limit arg to a valid integer in [1, maximum]."""
    if raw is None or raw == "":
        return default
    if isinstance(raw, bool):
        return default
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return default
    if value < 1:
        return 1
    if value > maximum:
        return maximum
    return value

# ── Provider ───────────────────────────────────────────────────────────

class MemoryTencentdbProvider:
    """Dify Plugin Provider for memory-tencentdb Gateway."""

    # Injected by Dify's plugin framework at registration time.
    # The framework reads these to build the credential form + tool registry.
    name = "memory_tencentdb"
    display_name = "TencentDB Agent Memory"
    version = "1.0.0"

    def __init__(self):
        self._client: Optional[MemoryTencentdbClient] = None
        self._gateway_host = ""
        self._gateway_port = ""

    # ── Credential management ──────────────────────────────────────────

    def validate_credentials(self, credentials: Dict[str, Any]) -> bool:
        """Called by Dify when the user saves the provider configuration.

        Expects:
            credentials.gateway_host  — Gateway hostname (default 127.0.0.1)
            credentials.gateway_port  — Gateway port (default 8420)
            credentials.api_key       — Optional Bearer token
        """
        host = credentials.get("gateway_host") or _resolve_env_var("TDAI_GATEWAY_HOST", "127.0.0.1")
        port = str(credentials.get("gateway_port") or _resolve_env_var("TDAI_GATEWAY_PORT", "8420"))
        api_key = credentials.get("api_key") or _resolve_env_var("TDAI_GATEWAY_API_KEY")
        base_url = f"http://{host}:{port}"

        self._gateway_host = host
        self._gateway_port = port
        self._client = MemoryTencentdbClient(base_url=base_url, api_key=api_key or None)

        try:
            health = self._client.health(timeout=5)
            if health.get("status") in ("ok", "degraded"):
                logger.info(f"memory-tencentdb Gateway healthy at {base_url}")
                return True
            logger.warning(f"memory-tencentdb Gateway status: %s", health.get("status"))
            return False
        except Exception as e:
            logger.error(f"memory-tencentdb Gateway not reachable at {base_url}: {e}")
            return False

    # ── Tool definitions ───────────────────────────────────────────────

    def get_tools(self) -> list[Dict[str, Any]]:
        """Return the schema definitions for registered tools."""
        return TOOL_DEFINITIONS

    # ── Tool invocation ────────────────────────────────────────────────

    def invoke_tool(self, tool_name: str, parameters: Dict[str, Any]) -> str:
        """Route a Dify tool call to the Gateway.

        Dify calls this synchronously — the LLM's tool-call loop blocks on
        the returned text blob. Keep timeouts short so bad Gateway state
        surfaces quickly rather than stalling the agent.
        """
        if not self._client:
            return json.dumps({
                "error": "memory-tencentdb Gateway is not connected. Configure the provider first.",
            })

        try:
            if tool_name == "memory_tencentdb_memory_search":
                query = parameters.get("query", "")
                if not query:
                    return json.dumps({"error": "Missing required parameter: query"})
                limit = _coerce_limit(parameters.get("limit"))
                type_filter = parameters.get("type", "") or ""
                scene = parameters.get("scene", "") or ""
                result = self._client.search_memories(
                    query=query,
                    limit=limit,
                    type_filter=type_filter,
                    scene=scene,
                )
                return result.get("results", json.dumps(result))

            elif tool_name == "memory_tencentdb_conversation_search":
                query = parameters.get("query", "")
                if not query:
                    return json.dumps({"error": "Missing required parameter: query"})
                limit = _coerce_limit(parameters.get("limit"))
                session_key = parameters.get("session_key", "") or ""
                result = self._client.search_conversations(
                    query=query,
                    limit=limit,
                    session_key=session_key,
                )
                return result.get("results", json.dumps(result))

            else:
                return json.dumps({"error": f"Unknown tool: {tool_name}"})

        except Exception as e:
            logger.warning(f"memory-tencentdb tool {tool_name} failed: {e}")
            return json.dumps({"error": f"Tool call failed: {e}"})

    # ── Lifecycle hooks (optional — host-dependent) ────────────────────

    def on_message(self, user_content: str, assistant_content: str, session_key: str) -> None:
        """Capture a turn after the agent finishes responding.

        Called by the Dify host in fire-and-forget mode (no response
        awaited). If the Gateway is unreachable the capture is silently
        dropped — the next turn's recall will still work from whatever
        was previously captured.
        """
        if not self._client:
            return
        try:
            self._client.capture(
                user_content=user_content,
                assistant_content=assistant_content,
                session_key=session_key,
            )
        except Exception as e:
            logger.debug(f"memory-tencentdb capture skipped (non-fatal): {e}")

    def on_session_end(self, session_key: str) -> None:
        """Flush per-session buffered work."""
        if not self._client:
            return
        try:
            self._client.end_session(session_key=session_key)
        except Exception as e:
            logger.debug(f"memory-tencentdb session_end skipped: {e}")
