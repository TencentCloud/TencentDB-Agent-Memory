"""Dify provider for TencentDB Agent Memory Gateway credentials."""

from __future__ import annotations

from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from tools.client import TdaiGatewayClient, TdaiGatewayError


class TdaiMemoryProvider(ToolProvider):
    """Validate Dify provider credentials against the Gateway."""

    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        gateway_url = str(credentials.get("gateway_url") or "").strip()
        if not gateway_url:
            raise ToolProviderCredentialValidationError("Gateway URL is required")

        try:
            client = TdaiGatewayClient.from_credentials(credentials)
            # `/health` is intentionally unauthenticated, so use a read-only
            # search request to validate Bearer credentials when auth is on.
            client.search_memories("__dify_credential_validation__", limit=1)
        except TdaiGatewayError as exc:
            message = "Gateway credential validation failed"
            if exc.status_code:
                message = f"{message} (HTTP {exc.status_code})"
            raise ToolProviderCredentialValidationError(message) from exc
