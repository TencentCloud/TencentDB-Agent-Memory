from __future__ import annotations

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from tools.base import TdaiToolMixin, build_error_payload


class TdaiHealthTool(TdaiToolMixin, Tool):
    """Check whether the TencentDB Agent Memory Gateway is reachable."""

    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        try:
            result = self._client().health()
            payload = {"ok": True}
            for key in ("status", "version", "uptime", "stores"):
                if key in result:
                    payload[key] = result[key]
            yield self.create_json_message(payload)
        except Exception as exc:
            yield self.create_json_message(build_error_payload("health", exc))
