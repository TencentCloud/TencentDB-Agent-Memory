from __future__ import annotations

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.base import TdaiToolMixin, build_error_payload


class TdaiCaptureTool(TdaiToolMixin, Tool):
    """Capture a completed Dify conversation turn into TDAI memory."""

    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        try:
            result = self._client().capture(
                self._text(tool_parameters, "user_content"),
                self._text(tool_parameters, "assistant_content"),
                self._text(tool_parameters, "session_key"),
                session_id=self._text(tool_parameters, "session_id"),
                user_id=self._text(tool_parameters, "user_id"),
            )
            payload = {"ok": True}
            for key in ("l0_recorded", "scheduler_notified"):
                if key in result:
                    payload[key] = result[key]
            yield self.create_json_message(payload)
        except Exception as exc:
            yield self.create_json_message(build_error_payload("capture", exc))
