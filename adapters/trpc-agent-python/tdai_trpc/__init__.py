"""TencentDB Agent Memory integration for trpc-agent-python.

Provides :class:`TencentDBMemoryService`, a ``MemoryServiceABC``
implementation backed by the TencentDB Agent Memory gateway. See the package
README for the full guide.
"""

from __future__ import annotations

from .config import ConfigError, TDAiConfig
from .gateway_client import GatewayError, MemoryGatewayClient
from .service import TencentDBMemoryService

__all__ = [
    "ConfigError",
    "GatewayError",
    "MemoryGatewayClient",
    "TDAiConfig",
    "TencentDBMemoryService",
]
