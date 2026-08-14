"""
TencentDB Agent Memory - Python Adapter SDK.

Provides a unified interface for any platform to integrate TDAI memory.
Includes:
- TdaiAdapter (ABC): Abstract contract for platform adapters
- TdaiHttpClient: HTTP client for Gateway communication
- TdaiAdapterRegistry: Multi-adapter management
"""

from .base import TdaiAdapter
from .client import TdaiHttpClient
from .registry import TdaiAdapterRegistry
from .errors import TdaiError, TdaiConnectionError, TdaiAuthError, TdaiRateLimitError

__all__ = [
    "TdaiAdapter",
    "TdaiHttpClient",
    "TdaiAdapterRegistry",
    "TdaiError",
    "TdaiConnectionError",
    "TdaiAuthError",
    "TdaiRateLimitError",
]
