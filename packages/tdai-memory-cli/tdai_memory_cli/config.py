from __future__ import annotations

import os
from dataclasses import dataclass

from .session import generate_default_session_key

DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420"
DEFAULT_TIMEOUT_MS = 30_000


@dataclass(frozen=True)
class AdapterConfig:
    gateway_url: str
    api_key: str
    default_session_key: str
    user_id: str
    timeout_ms: int


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
