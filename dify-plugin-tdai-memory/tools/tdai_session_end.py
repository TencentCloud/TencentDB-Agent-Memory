from __future__ import annotations

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.base import TdaiToolMixin, build_error_payload


class TdaiSessionEndTool(TdaiToolMixin, Tool):
    """Flush a Dify conversation session without stopping the Gateway."""

    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        try:
            result = self._client().end_session(
                self._text(tool_parameters, "session_key"),
                user_id=self._text(tool_parameters, "user_id"),
            )
            payload = {"ok": True}
            if "flushed" in result:
                payload["flushed"] = result["flushed"]
            yield self.create_json_message(payload)
        except Exception as exc:
            yield self.create_json_message(build_error_payload("session_end", exc))
