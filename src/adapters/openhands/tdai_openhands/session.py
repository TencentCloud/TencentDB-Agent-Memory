from __future__ import annotations

from .utils import slug


def hook_session_key(prefix: str, session_id: str) -> str:
    return f"{prefix.rstrip('/')}/{slug(session_id)}"
