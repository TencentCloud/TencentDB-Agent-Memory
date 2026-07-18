from __future__ import annotations

import sys
from pathlib import Path


ADAPTER_ROOT = Path(__file__).resolve().parents[2]
if str(ADAPTER_ROOT) not in sys.path:
    sys.path.insert(0, str(ADAPTER_ROOT))

from tdai_openhands.mcp_server import (
    main,
    mcp,
    tdai_conversation_search,
    tdai_memory_search,
)


__all__ = [
    "main",
    "mcp",
    "tdai_conversation_search",
    "tdai_memory_search",
]


if __name__ == "__main__":
    main()
