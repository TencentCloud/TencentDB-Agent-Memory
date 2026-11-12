#!/usr/bin/env python3
"""Whale SessionStart hook: verify the TdaiGateway is reachable.

Fails silently (exit 0, no output) so session start is never blocked.
"""
import os
import sys
import urllib.request

GATEWAY = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")


def main() -> None:
    try:
        urllib.request.urlopen(f"{GATEWAY}/health", timeout=5)
    except Exception:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
