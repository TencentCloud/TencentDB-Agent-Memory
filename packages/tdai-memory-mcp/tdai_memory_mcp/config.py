from __future__ import annotations

import os
from dataclasses import dataclass

from .session import generate_default_session_key

DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420"
DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_GATEWAY_STARTUP_TIMEOUT_MS = 30_000
DEFAULT_GATEWAY_HEALTH_POLL_MS = 500


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


def load_config(env: dict[str, str] | None = None, cwd: str | None = None) -> AdapterConfig:
    source = env if env is not None else os.environ
    current_cwd = cwd or os.getcwd()
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
