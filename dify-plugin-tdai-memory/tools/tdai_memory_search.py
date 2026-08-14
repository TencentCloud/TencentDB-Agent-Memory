from __future__ import annotations

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.base import TdaiToolMixin, build_error_payload, normalize_limit, truncate_text


class TdaiMemorySearchTool(TdaiToolMixin, Tool):
    """Search L1 structured memories through the Gateway."""

    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        try:
            result = self._client().search_memories(
                self._text(tool_parameters, "query"),
                limit=normalize_limit(tool_parameters.get("limit")),
                type_filter=self._text(tool_parameters, "type"),
                scene=self._text(tool_parameters, "scene"),
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
            yield self.create_json_message(build_error_payload("memory_search", exc))
