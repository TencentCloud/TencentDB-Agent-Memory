"""TencentDB Agent Memory adapter for DeerFlow.

The package root keeps imports lazy so the dependency-free Gateway client can
be used without importing DeerFlow/LangChain modules.
"""

from .client import TdaiGatewayClient, TdaiGatewayError

__all__ = [
    "TdaiGatewayClient",
    "TdaiGatewayError",
    "TdaiMemoryMiddleware",
    "TdaiMemoryStorage",
]


def __getattr__(name: str):
    if name == "TdaiMemoryMiddleware":
        from .middleware import TdaiMemoryMiddleware

        return TdaiMemoryMiddleware
    if name == "TdaiMemoryStorage":
        from .storage import TdaiMemoryStorage

        return TdaiMemoryStorage
    raise AttributeError(name)
