from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .config import AdapterConfig

HEARTBEAT_FILE = "heartbeat.json"
GATEWAY_PID_FILE = "gateway.pid"
GATEWAY_INFO_FILE = "gateway.json"
WATCHDOG_PID_FILE = "watchdog.pid"


def runtime_dir(config: AdapterConfig) -> Path:
    return Path(config.gateway_runtime_dir).expanduser()


def log_dir(config: AdapterConfig) -> Path:
    return Path(config.gateway_log_dir).expanduser()


def ensure_runtime_dirs(config: AdapterConfig) -> None:
    runtime_dir(config).mkdir(parents=True, exist_ok=True)
    log_dir(config).mkdir(parents=True, exist_ok=True)


def touch_heartbeat(
    config: AdapterConfig,
    *,
    session_key: str = "",
    user_id: str = "",
    now: float | None = None,
) -> bool:
    try:
        ensure_runtime_dirs(config)
        path = runtime_dir(config) / HEARTBEAT_FILE
        timestamp = time.time() if now is None else now
        payload = read_json(path)
        sessions = _sessions_by_key(payload.get("sessions"))
        clean_session_key = session_key.strip()
        if clean_session_key:
            sessions[clean_session_key] = {
                "session_key": clean_session_key,
                "user_id": user_id.strip() or config.user_id,
                "updated_at": timestamp,
            }
        write_json_atomic(path, {
            "updated_at": timestamp,
            "gateway_url": config.gateway_url,
            "sessions": list(sessions.values())[-100:],
        })
        return True
    except Exception:
        return False


def read_heartbeat(config: AdapterConfig) -> dict[str, Any]:
    return read_json(runtime_dir(config) / HEARTBEAT_FILE)


def write_gateway_process_info(
    config: AdapterConfig,
    *,
    pid: int,
    command: list[str],
    started_at: float | None = None,
) -> None:
    ensure_runtime_dirs(config)
    timestamp = time.time() if started_at is None else started_at
    (runtime_dir(config) / GATEWAY_PID_FILE).write_text(f"{pid}\n", encoding="utf-8")
    write_json_atomic(runtime_dir(config) / GATEWAY_INFO_FILE, {
        "pid": pid,
        "command": command,
        "started_at": timestamp,
        "gateway_url": config.gateway_url,
        "gateway_cwd": config.gateway_cwd,
        "gateway_config_path": config.gateway_config_path,
    })


def read_gateway_process_info(config: AdapterConfig) -> dict[str, Any]:
    info = read_json(runtime_dir(config) / GATEWAY_INFO_FILE)
    if isinstance(info.get("pid"), int):
        return info
    pid = read_pid(runtime_dir(config) / GATEWAY_PID_FILE)
    return {"pid": pid} if pid else {}


def clear_gateway_process_info(config: AdapterConfig) -> None:
    for name in (GATEWAY_PID_FILE, GATEWAY_INFO_FILE):
        _unlink_quietly(runtime_dir(config) / name)


def write_watchdog_pid(config: AdapterConfig, pid: int) -> None:
    ensure_runtime_dirs(config)
    (runtime_dir(config) / WATCHDOG_PID_FILE).write_text(f"{pid}\n", encoding="utf-8")


def read_watchdog_pid(config: AdapterConfig) -> int:
    return read_pid(runtime_dir(config) / WATCHDOG_PID_FILE)


def clear_watchdog_pid(config: AdapterConfig) -> None:
    _unlink_quietly(runtime_dir(config) / WATCHDOG_PID_FILE)


def read_pid(path: Path) -> int:
    try:
        raw = path.read_text(encoding="utf-8").strip()
        return int(raw) if raw else 0
    except Exception:
        return 0


def is_process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def ensure_watchdog_running(config: AdapterConfig) -> str:
    if config.gateway_idle_timeout_seconds <= 0:
        return "disabled"

    gateway_info = read_gateway_process_info(config)
    gateway_pid = int(gateway_info.get("pid") or 0)
    if not is_process_alive(gateway_pid):
        return "no-gateway"

    watchdog_pid = read_watchdog_pid(config)
    if is_process_alive(watchdog_pid):
        return "already-running"

    ensure_runtime_dirs(config)
    env = dict(os.environ)
    env.update({
        "TDAI_GATEWAY_URL": config.gateway_url,
        "TDAI_GATEWAY_RUNTIME_DIR": config.gateway_runtime_dir,
        "TDAI_GATEWAY_LOG_DIR": config.gateway_log_dir,
        "TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS": str(config.gateway_idle_timeout_seconds),
        "TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS": str(config.gateway_watchdog_interval_seconds),
        "TDAI_REQUEST_TIMEOUT_MS": str(config.timeout_ms),
    })
    if config.api_key:
        env["TDAI_GATEWAY_API_KEY"] = config.api_key
    if config.user_id:
        env["TDAI_USER_ID"] = config.user_id

    stdout_path = log_dir(config) / "gateway-watchdog.log"
    with stdout_path.open("ab") as output:
        process = subprocess.Popen(
            [sys.executable, "-m", "tdai_memory_cli.gateway_watchdog"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=output,
            start_new_session=True,
        )
    write_watchdog_pid(config, process.pid)
    return "started"


def read_json(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text(encoding="utf-8")
        parsed = json.loads(raw) if raw.strip() else {}
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(path)


def _sessions_by_key(value: Any) -> dict[str, dict[str, Any]]:
    sessions: dict[str, dict[str, Any]] = {}
    if not isinstance(value, list):
        return sessions
    for item in value:
        if not isinstance(item, dict):
            continue
        key = str(item.get("session_key") or "").strip()
        if key:
            sessions[key] = item
    return sessions


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except Exception:
        pass
