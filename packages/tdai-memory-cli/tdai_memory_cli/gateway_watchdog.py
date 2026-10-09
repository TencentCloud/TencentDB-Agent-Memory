from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from .config import AdapterConfig, load_config
from .gateway_http import request_json
from .runtime import (
    clear_gateway_process_info,
    clear_watchdog_pid,
    is_process_alive,
    log_dir,
    read_gateway_process_info,
    read_heartbeat,
    runtime_dir,
    write_watchdog_pid,
)

RequestFunc = Callable[..., dict[str, Any]]
TerminateFunc = Callable[[AdapterConfig], bool]
AliveFunc = Callable[[int], bool]


def main() -> int:
    config = load_config()
    result = run_watchdog(config)
    _log(config, f"watchdog exiting: {result}")
    return 0


def run_watchdog(
    config: AdapterConfig,
    *,
    request_func: RequestFunc = request_json,
    sleep_func: Callable[[float], None] = time.sleep,
    now_func: Callable[[], float] = time.time,
    terminate_func: TerminateFunc | None = None,
    is_alive_func: AliveFunc = is_process_alive,
    max_iterations: int | None = None,
) -> str:
    write_watchdog_pid(config, os.getpid())
    terminate = terminate_func or terminate_owned_gateway
    iterations = 0

    try:
        if config.gateway_idle_timeout_seconds <= 0:
            return "disabled"

        _log(config, (
            "watchdog started "
            f"idle_timeout={config.gateway_idle_timeout_seconds}s "
            f"interval={config.gateway_watchdog_interval_seconds}s "
            f"runtime={runtime_dir(config)}"
        ))

        while True:
            gateway_info = read_gateway_process_info(config)
            gateway_pid = int(gateway_info.get("pid") or 0)
            if not is_alive_func(gateway_pid):
                clear_gateway_process_info(config)
                return "gateway-not-running"

            heartbeat = read_heartbeat(config)
            last_seen = float(heartbeat.get("updated_at") or 0)
            idle_for = now_func() - last_seen
            if last_seen <= 0 or idle_for >= config.gateway_idle_timeout_seconds:
                _log(config, f"idle timeout reached idle_for={idle_for:.1f}s")
                _flush_sessions(config, heartbeat, request_func=request_func)
                if terminate(config):
                    return "stopped-idle"
                return "stop-skipped"

            iterations += 1
            if max_iterations is not None and iterations >= max_iterations:
                return "max-iterations"

            sleep_func(config.gateway_watchdog_interval_seconds)
    finally:
        clear_watchdog_pid(config)


def terminate_owned_gateway(config: AdapterConfig) -> bool:
    gateway_info = read_gateway_process_info(config)
    pid = int(gateway_info.get("pid") or 0)
    if not is_process_alive(pid):
        clear_gateway_process_info(config)
        return False

    if not _looks_like_owned_gateway(pid, gateway_info):
        _log(config, f"refusing to stop pid={pid}: process command did not match Gateway")
        return False

    _log(config, f"stopping idle Gateway pid={pid}")
    _signal_process_group(pid, signal.SIGTERM)
    deadline = time.time() + 5
    while time.time() < deadline:
        if not is_process_alive(pid):
            clear_gateway_process_info(config)
            return True
        time.sleep(0.1)

    _signal_process_group(pid, signal.SIGKILL)
    clear_gateway_process_info(config)
    return True


def _flush_sessions(
    config: AdapterConfig,
    heartbeat: dict[str, Any],
    *,
    request_func: RequestFunc,
) -> None:
    sessions = heartbeat.get("sessions")
    if not isinstance(sessions, list):
        return
    seen: set[str] = set()
    for item in sessions:
        if not isinstance(item, dict):
            continue
        session_key = str(item.get("session_key") or "").strip()
        if not session_key or session_key in seen:
            continue
        seen.add(session_key)
        body = {"session_key": session_key}
        user_id = str(item.get("user_id") or config.user_id or "").strip()
        if user_id:
            body["user_id"] = user_id
        try:
            request_func(config, "/session/end", body=body, timeout_ms=min(config.timeout_ms, 5000))
            _log(config, f"flushed session_key={session_key}")
        except Exception as error:
            _log(config, f"session flush failed session_key={session_key}: {error}")


def _looks_like_owned_gateway(pid: int, gateway_info: dict[str, Any]) -> bool:
    current = _process_command(pid)
    if not current:
        return False

    command = gateway_info.get("command")
    expected = " ".join(str(item) for item in command) if isinstance(command, list) else ""
    if expected and expected in current:
        return True

    normalized = current.replace("\\", "/")
    if "src/gateway/server.ts" in normalized or "src/gateway/server.js" in normalized:
        return True

    if isinstance(command, list):
        script_names = {
            Path(str(item)).name
            for item in command
            if str(item).endswith((".ts", ".js"))
        }
        if script_names and all(name in current for name in script_names):
            return True

    return False


def _process_command(pid: int) -> str:
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=2,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def _signal_process_group(pid: int, sig: signal.Signals) -> None:
    try:
        os.killpg(pid, sig)
        return
    except ProcessLookupError:
        return
    except Exception:
        pass
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass
    except Exception:
        pass


def _log(config: AdapterConfig, message: str) -> None:
    try:
        log_dir(config).mkdir(parents=True, exist_ok=True)
        path = log_dir(config) / "gateway-watchdog.log"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {message}\n")
    except Exception:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
