from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from .utils import content_to_text, truncate_text


EVENT_NAME_RE = re.compile(r"^event-(?P<index>\d+)-.+\.json$")


@dataclass(frozen=True)
class NativeEventBatch:
    events: list[dict[str, Any]]
    next_index: int
    conversation_dir: Path


def openhands_conversations_dir(configured: str | None = None) -> Path:
    if configured:
        return Path(os.path.expandvars(os.path.expanduser(configured))).resolve()
    explicit = os.getenv("OPENHANDS_CONVERSATIONS_DIR")
    if explicit:
        return Path(os.path.expandvars(os.path.expanduser(explicit))).resolve()
    persistence = os.getenv("OPENHANDS_PERSISTENCE_DIR", "~/.openhands")
    return (
        Path(os.path.expandvars(os.path.expanduser(persistence))) / "conversations"
    ).resolve()


def conversation_dir_for_session(
    session_id: str,
    *,
    conversations_dir: str | Path | None = None,
) -> Path:
    base = (
        Path(conversations_dir).expanduser().resolve()
        if conversations_dir is not None
        else openhands_conversations_dir()
    )
    compact_id = session_id.replace("-", "")
    candidates = [base / compact_id]
    if compact_id != session_id:
        candidates.append(base / session_id)
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def load_native_events(
    session_id: str,
    *,
    since_index: int = 0,
    conversations_dir: str | Path | None = None,
    max_events: int | None = None,
) -> NativeEventBatch:
    conversation_dir = conversation_dir_for_session(
        session_id,
        conversations_dir=conversations_dir,
    )
    events_dir = conversation_dir / "events"
    indexed_paths: list[tuple[int, Path]] = []
    if events_dir.is_dir():
        for path in events_dir.glob("event-*.json"):
            match = EVENT_NAME_RE.match(path.name)
            if match:
                indexed_paths.append((int(match.group("index")), path))
    indexed_paths.sort(key=lambda item: item[0])
    selected = [item for item in indexed_paths if item[0] >= max(0, since_index)]
    if max_events is not None and max_events > 0:
        selected = selected[:max_events]

    events: list[dict[str, Any]] = []
    next_index = max(0, since_index)
    for index, path in selected:
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            events.append(value)
        next_index = max(next_index, index + 1)
    return NativeEventBatch(
        events=events,
        next_index=next_index,
        conversation_dir=conversation_dir,
    )


def native_event_count(
    session_id: str,
    *,
    conversations_dir: str | Path | None = None,
) -> int:
    return load_native_events(
        session_id,
        conversations_dir=conversations_dir,
    ).next_index


def messages_from_native_events(
    events: list[dict[str, Any]],
    *,
    max_content_chars: int = 4000,
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for event in events:
        llm_message = event.get("llm_message")
        if not isinstance(llm_message, dict):
            continue
        text = content_to_text(llm_message.get("content")).strip()
        if not text or "<tdai_recall_context>" in text:
            continue
        raw_role = str(llm_message.get("role") or event.get("source") or "user").lower()
        role = "assistant" if raw_role in {"assistant", "agent"} else "user"
        message: dict[str, Any] = {
            "role": role,
            "content": truncate_text(text, max_content_chars),
        }
        timestamp = _timestamp_millis(event.get("timestamp"))
        if timestamp is not None:
            message["timestamp"] = timestamp
        messages.append(message)
    return messages


def _timestamp_millis(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        numeric = float(value)
        return int(numeric if numeric >= 1_000_000_000_000 else numeric * 1000)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(parsed.timestamp() * 1000)
