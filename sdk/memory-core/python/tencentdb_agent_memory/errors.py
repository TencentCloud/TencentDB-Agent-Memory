"""TencentDB Agent Memory SDK error types."""

from __future__ import annotations

from typing import Any, Mapping, Optional


class TDAMError(Exception):
    """Raised when the API returns a non-zero business code.

    ``details`` carries any envelope ``data`` payload returned alongside the
    error — used by /v3/skill/* endpoints to hand back ``current_version``
    (40901 SKILL_VERSION_STALE) or ``latest_version`` (41002
    SKILL_VERSION_EXPIRED) so the caller can retry / upgrade cleanly.
    """

    def __init__(
        self,
        code: int,
        message: str,
        request_id: str = "",
        details: Optional[Mapping[str, Any]] = None,
    ) -> None:
        super().__init__(code, message, request_id, details)
        self.code = code
        self.message = message
        self.request_id = request_id
        self.details = dict(details) if details else None

    def __str__(self) -> str:
        if self.request_id:
            return (
                f"<TDAMError: (code={self.code}, "
                f"message={self.message}, request_id={self.request_id})>"
            )
        return f"<TDAMError: (code={self.code}, message={self.message})>"


class ParamError(Exception):
    """Raised when caller-supplied parameters are invalid."""
