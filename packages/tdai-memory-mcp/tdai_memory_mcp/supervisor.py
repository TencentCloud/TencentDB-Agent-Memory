from __future__ import annotations

import os
import shlex
import signal
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

from .client import GatewayClient
from .config import AdapterConfig


class GatewaySupervisor:
    def __init__(self, config: AdapterConfig, client: GatewayClient | None = None):
        self.config = config
        self.client = client or GatewayClient(
            gateway_url=config.gateway_url,
            timeout_ms=min(config.timeout_ms, 3000),
            api_key=config.api_key,
        )
        self.process: subprocess.Popen[bytes] | None = None
        self.started_by_supervisor = False

    def ensure_running(self) -> None:
        if self.is_healthy():
            return

        command = self._resolve_command()
        if not command:
            raise RuntimeError(
                "TDAI Gateway is not reachable. Start it manually, set "
                "TDAI_GATEWAY_CMD, or set TDAI_GATEWAY_AUTO_START=1."
            )

        self._start_process(command)
        self._wait_for_health()

    def stop(self) -> None:
        child = self.process
        self.process = None
        if child is None or not self.started_by_supervisor:
            return
        if child.poll() is not None:
            return
        try:
            child.terminate()
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
        except Exception:
            pass

    def is_healthy(self) -> bool:
        try:
            result = self.client.health()
            return result.get("status") in {"ok", "degraded"}
        except Exception:
            return False

    def _resolve_command(self) -> list[str] | None:
        if self.config.gateway_command:
            return shlex.split(self.config.gateway_command)
        if not self.config.gateway_auto_start:
            return None
        server_ts = Path(self.config.gateway_cwd) / "src" / "gateway" / "server.ts"
        return ["node", "--import", "tsx", str(server_ts)]

    def _start_process(self, command: list[str]) -> None:
        if self.process and self.process.poll() is None:
            return

        env = dict(os.environ)
        env["TDAI_GATEWAY_URL"] = self.config.gateway_url
        parsed = urlparse(self.config.gateway_url)
        env["TDAI_GATEWAY_HOST"] = parsed.hostname or "127.0.0.1"
        env["TDAI_GATEWAY_PORT"] = str(parsed.port or (443 if parsed.scheme == "https" else 80))
        if self.config.gateway_config_path:
            env["TDAI_GATEWAY_CONFIG"] = self.config.gateway_config_path

        self.process = subprocess.Popen(
            command,
            cwd=self.config.gateway_cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=None,
            start_new_session=True,
        )
        self.started_by_supervisor = True

    def _wait_for_health(self) -> None:
        deadline = time.time() + (self.config.gateway_startup_timeout_ms / 1000)
        while time.time() < deadline:
            if self.is_healthy():
                return
            time.sleep(self.config.gateway_health_poll_ms / 1000)
        raise RuntimeError(
            f"TDAI Gateway did not become healthy within "
            f"{self.config.gateway_startup_timeout_ms}ms"
        )
