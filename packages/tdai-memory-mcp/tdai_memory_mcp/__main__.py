from __future__ import annotations

import sys

from .protocol import McpServer
from .side_channel import main as side_channel_main


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args:
        return side_channel_main(args)
    McpServer().serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
