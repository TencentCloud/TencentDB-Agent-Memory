"""memory-tencentdb adapter for Google ADK (Agent Development Kit).

Bridges ADK's ``BaseMemoryService`` interface to the memory-tencentdb
Gateway sidecar (``src/gateway/server.ts``), giving ADK agents fully local
four-layer long-term memory (L0 conversation, L1 extraction, L2 scene
blocks, L3 persona synthesis).

Layout:
    client.py  — stdlib HTTP client for the Gateway API (no dependencies)
    turns.py   — pure helpers that pair ADK session events into turns
    service.py — ``TdaiMemoryService`` (requires ``google-adk``)

``client`` and ``turns`` are dependency-free so they can be reused and
tested without installing ADK. ``service`` imports ``google.adk`` and is
the piece you hand to ``Runner(memory_service=...)``.
"""

from .client import TdaiGatewayClient, TdaiGatewayError

__version__ = "0.1.0"

__all__ = [
    "TdaiGatewayClient",
    "TdaiGatewayError",
    "TdaiMemoryService",
    "__version__",
]


def __getattr__(name: str):
    # Lazy import so `import memory_tencentdb_adk` works without google-adk
    # installed (e.g. when only the Gateway client is needed).
    if name == "TdaiMemoryService":
        from .service import TdaiMemoryService

        return TdaiMemoryService
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
