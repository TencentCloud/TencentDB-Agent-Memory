"""Compatibility re-export for the shared TencentDB Agent Memory adapter SDK."""

from __future__ import annotations

from ._sdk import ensure_adapter_sdk_path

ensure_adapter_sdk_path()

from tdai_adapter_sdk import TdaiGatewayClient, TdaiGatewayError  # noqa: E402

__all__ = ["TdaiGatewayClient", "TdaiGatewayError"]
