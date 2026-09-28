from __future__ import annotations

import os
import shlex
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

from .config import AdapterConfig
from .gateway_http import GatewayHttpError, request_json
from .runtime import (
    ensure_runtime_dirs,
    ensure_watchdog_running,
    log_dir,
    touch_heartbeat,
    write_gateway_process_info,
)


def ensure_gateway_running(config: AdapterConfig, *, request_func=request_json) -> str:
    touch_heartbeat(config)
    if _is_healthy(config, request_func=request_func):
        ensure_watchdog_running(config)
        return "already-running"

    command = _resolve_command(config)
    if not command:
        raise RuntimeError(
            "TDAI Gateway is not reachable. Start it manually, set TDAI_GATEWAY_CMD, "
            "or set TDAI_GATEWAY_AUTO_START=1."
        )

    _start_gateway_process(config, command)
    _wait_for_health(config, request_func=request_func)
    ensure_watchdog_running(config)
    return "started"


def _is_healthy(config: AdapterConfig, *, request_func=request_json) -> bool:
    try:
        result = request_func(config, "/health", method="GET", timeout_ms=min(config.timeout_ms, 3000))
        return result.get("status") in {"ok", "degraded"}
    except Exception:
        return False


def _resolve_command(config: AdapterConfig) -> list[str] | None:
    if config.gateway_command:
        return shlex.split(config.gateway_command)
    if not config.gateway_auto_start:
        return None
    server_ts = Path(config.gateway_cwd) / "src" / "gateway" / "server.ts"
    return ["node", "--import", "tsx", str(server_ts)]


def _start_gateway_process(config: AdapterConfig, command: list[str]) -> None:
    ensure_runtime_dirs(config)
    env = dict(os.environ)
    env["TDAI_GATEWAY_URL"] = config.gateway_url
    parsed = urlparse(config.gateway_url)
    env["TDAI_GATEWAY_HOST"] = parsed.hostname or "127.0.0.1"
    env["TDAI_GATEWAY_PORT"] = str(parsed.port or (443 if parsed.scheme == "https" else 80))
    if config.gateway_config_path:
        env["TDAI_GATEWAY_CONFIG"] = config.gateway_config_path

    output_path = log_dir(config) / "gateway.log"
    output = output_path.open("ab")
    process = subprocess.Popen(
        command,
        cwd=config.gateway_cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=output,
        stderr=output,
        start_new_session=True,
    )
    output.close()
    write_gateway_process_info(config, pid=process.pid, command=command)


def _wait_for_health(config: AdapterConfig, *, request_func=request_json) -> None:
    deadline = time.time() + (config.gateway_startup_timeout_ms / 1000)
    while time.time() < deadline:
        if _is_healthy(config, request_func=request_func):
            return
        time.sleep(config.gateway_health_poll_ms / 1000)
    raise RuntimeError(
        f"TDAI Gateway did not become healthy within {config.gateway_startup_timeout_ms}ms"
    )
