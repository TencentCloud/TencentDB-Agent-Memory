from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote


@dataclass(frozen=True, slots=True)
class MemoryIdentity:
    user_id: str
    session_id: str
    session_key: str

    @classmethod
    def create(
        cls,
        user_id: str,
        session_id: str,
        *,
        session_key: str | None = None,
    ) -> "MemoryIdentity":
        clean_user = user_id.strip()
        clean_session = session_id.strip()
        if not clean_user:
            raise ValueError("user_id must not be empty")
        if not clean_session:
            raise ValueError("session_id must not be empty")

        if session_key is not None:
            clean_key = session_key.strip()
            if not clean_key:
                raise ValueError("session_key must not be empty")
        else:
            clean_key = (
                f"pydantic-ai:{quote(clean_user, safe='')}:"
                f"{quote(clean_session, safe='')}"
            )

        return cls(clean_user, clean_session, clean_key)
