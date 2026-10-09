from __future__ import annotations

import hashlib
from pathlib import Path


def sanitize_session_part(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._:-" else "-" for ch in value.strip())
    return cleaned.strip("-") or "default"


def generate_default_session_key(cwd: str) -> str:
    path = Path(cwd).resolve()
    name = sanitize_session_part(path.name)
    digest = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:10]
    return f"mcp:{name}:{digest}"


def resolve_session_key(value: str | None, default: str) -> str:
    candidate = (value or "").strip()
    return candidate or default
