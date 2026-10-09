from __future__ import annotations

import argparse
import sys
from typing import Any

from .client import GatewayClient
from .config import load_config
from .formatters import format_error, format_health
from .supervisor import GatewaySupervisor


def main(argv: list[str] | None = None) -> int:
    result = run_side_channel(argv)
    if result.get("stdout"):
        print(result["stdout"])
    if result.get("stderr"):
        print(result["stderr"], file=sys.stderr)
    return int(result["code"])


def run_side_channel(
    argv: list[str] | None = None,
    *,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    client: Any | None = None,
    supervisor: Any | None = None,
) -> dict[str, Any]:
    parser = argparse.ArgumentParser(prog="tdai-memory-mcp")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("health", help="Check Gateway health through the MCP adapter side-channel.")

    try:
        args = parser.parse_args(argv)
        if args.command != "health":
            return {"code": 2, "stderr": f"Unknown side-channel command: {args.command}"}

        config = load_config(env=env, cwd=cwd)
        client = client or GatewayClient(config.gateway_url, timeout_ms=config.timeout_ms, api_key=config.api_key)
        supervisor = supervisor or GatewaySupervisor(config, client)
        try:
            supervisor.ensure_running()
            return {"code": 0, "stdout": format_health(client.health())}
        finally:
            supervisor.stop()
    except SystemExit as error:
        return {"code": int(error.code)}
    except Exception as error:
        return {"code": 1, "stderr": format_error(error)}
