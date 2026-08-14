from __future__ import annotations

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.base import TdaiToolMixin, build_error_payload, normalize_limit, truncate_text


class TdaiConversationSearchTool(TdaiToolMixin, Tool):
    """Search L0 raw conversations through the Gateway."""

    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        try:
            result = self._client().search_conversations(
                self._text(tool_parameters, "query"),
                limit=normalize_limit(tool_parameters.get("limit")),
                session_key=self._text(tool_parameters, "session_key"),
            )
            raw_results = result.get("results")
            results = truncate_text(
                str(raw_results) if raw_results is not None else "",
                self._max_chars(tool_parameters),
            )
            payload: dict[str, Any] = {"ok": True, "results": results}
            for key in ("total", "strategy"):
                if key in result:
                    payload[key] = result[key]
            yield self.create_json_message(payload)
        except Exception as exc:
            yield self.create_json_message(build_error_payload("conversation_search", exc))
