from __future__ import annotations

import json
import os
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from .utils import slug


def current_time_millis() -> int:
    return int(time.time() * 1000)


@dataclass
class HookSessionState:
    session_id: str
    session_key: str
    next_event_index: int = 0
    started_at: int | None = None


class HookStateStore:
    def __init__(self, directory: str | Path) -> None:
        self.directory = Path(
            os.path.expandvars(os.path.expanduser(str(directory)))
        ).resolve()

    def load(self, session_id: str) -> HookSessionState | None:
        path = self._path(session_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(data, dict):
            return None
        return HookSessionState(
            session_id=str(data.get("session_id") or session_id),
            session_key=str(data.get("session_key") or ""),
            next_event_index=max(0, int(data.get("next_event_index") or 0)),
            started_at=(
                int(data["started_at"])
                if data.get("started_at") is not None
                else None
            ),
        )
    def save(self, state: HookSessionState) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(
            prefix=f".{slug(state.session_id)}-",
            suffix=".tmp",
            dir=self.directory,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(asdict(state), handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temporary, self._path(state.session_id))
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def delete(self, session_id: str) -> None:
        try:
            self._path(session_id).unlink()
        except FileNotFoundError:
            pass

    def _path(self, session_id: str) -> Path:
        return self.directory / f"{slug(session_id)}.json"
