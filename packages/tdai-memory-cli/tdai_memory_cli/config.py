from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from .session import generate_default_session_key

DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420"
DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS = 30_000
DEFAULT_GATEWAY_HEALTH_POLL_MS = 500
DEFAULT_GATEWAY_IDLE_TIMEOUT_SECONDS = 600
DEFAULT_GATEWAY_WATCHDOG_INTERVAL_SECONDS = 30


@dataclass(frozen=True)
class AdapterConfig:
    gateway_url: str
    api_key: str
    default_session_key: str
    user_id: str
    timeout_ms: int
    gateway_auto_start: bool
    gateway_command: str
    gateway_cwd: str
    gateway_config_path: str
    gateway_startup_timeout_ms: int
    gateway_health_poll_ms: int
    gateway_runtime_dir: str
    gateway_log_dir: str
    gateway_idle_timeout_seconds: int
    gateway_watchdog_interval_seconds: int


def load_config(env: dict[str, str] | None = None, cwd: str | None = None) -> AdapterConfig:
    source = env if env is not None else os.environ
    current_cwd = cwd or os.getcwd()
    default_memory_dir = Path.home() / ".codex" / "tdai-memory"
    return AdapterConfig(
        gateway_url=_normalize_gateway_url(source.get("TDAI_GATEWAY_URL")),
        api_key=(source.get("TDAI_GATEWAY_API_KEY") or "").strip(),
        default_session_key=(source.get("TDAI_SESSION_KEY") or "").strip()
        or generate_default_session_key(current_cwd),
        user_id=(source.get("TDAI_USER_ID") or "").strip(),
        timeout_ms=_read_positive_int(source.get("TDAI_REQUEST_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS),
        gateway_auto_start=_read_bool(source.get("TDAI_GATEWAY_AUTO_START")),
        gateway_command=(source.get("TDAI_GATEWAY_CMD") or "").strip(),
        gateway_cwd=(source.get("TDAI_GATEWAY_CWD") or current_cwd).strip() or current_cwd,
        gateway_config_path=(source.get("TDAI_GATEWAY_CONFIG") or "").strip(),
        gateway_startup_timeout_ms=_read_positive_int(
            source.get("TDAI_GATEWAY_STARTUP_TIMEOUT_MS"),
            DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS,
        ),
        gateway_health_poll_ms=_read_positive_int(
            source.get("TDAI_GATEWAY_HEALTH_POLL_MS"),
            DEFAULT_GATEWAY_HEALTH_POLL_MS,
        ),
        gateway_runtime_dir=_read_path(
            source.get("TDAI_GATEWAY_RUNTIME_DIR"),
            default_memory_dir / "runtime",
        ),
        gateway_log_dir=_read_path(
            source.get("TDAI_GATEWAY_LOG_DIR"),
            default_memory_dir / "logs",
        ),
        gateway_idle_timeout_seconds=_read_nonnegative_int(
            source.get("TDAI_GATEWAY_IDLE_TIMEOUT_SECONDS"),
            DEFAULT_GATEWAY_IDLE_TIMEOUT_SECONDS,
        ),
        gateway_watchdog_interval_seconds=_read_positive_int(
            source.get("TDAI_GATEWAY_WATCHDOG_INTERVAL_SECONDS"),
            DEFAULT_GATEWAY_WATCHDOG_INTERVAL_SECONDS,
        ),
    )


def _normalize_gateway_url(value: str | None) -> str:
    raw = (value or DEFAULT_GATEWAY_URL).strip() or DEFAULT_GATEWAY_URL
    return raw.rstrip("/")


def _read_positive_int(value: str | None, fallback: int) -> int:
    try:
        parsed = int(str(value or "").strip())
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def _read_bool(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _read_nonnegative_int(value: str | None, fallback: int) -> int:
    try:
        parsed = int(str(value or "").strip())
    except ValueError:
        return fallback
    return parsed if parsed >= 0 else fallback


def _read_path(value: str | None, fallback: Path) -> str:
    raw = (value or "").strip()
    path = Path(raw).expanduser() if raw else fallback
    return str(path)
