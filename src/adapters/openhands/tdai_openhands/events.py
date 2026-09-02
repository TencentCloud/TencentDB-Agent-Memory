from __future__ import annotations

import json
from typing import Any

from .utils import content_to_text, json_safe, truncate_text


def summarize_events(events: list[dict[str, Any]], *, max_chars: int) -> str:
    if not events:
        return "OpenHands run finished. No events were provided to the TDAI adapter."
    lines = [f"OpenHands run finished with {len(events)} exported events."]
    for idx, event in enumerate(events[-20:], start=max(1, len(events) - 19)):
        lines.append(f"\n[event {idx}] {event_brief(event)}")
    return truncate_text("\n".join(lines), max_chars, marker="[tdai] OpenHands event summary truncated.")


def event_brief(event: dict[str, Any]) -> str:
    kind = str(event.get("kind") or event.get("type") or event.get("event_type") or event.get("source") or "event")
    role = str(event.get("role") or event.get("actor") or "")
    text = _event_text(event)
    prefix = f"{kind}"
    if role:
        prefix += f"/{role}"
    if text:
        return f"{prefix}: {truncate_text(text, 800)}"
    return f"{prefix}: {json.dumps(json_safe(event), ensure_ascii=False)[:800]}"


def _event_text(event: dict[str, Any]) -> str:
    llm_message = event.get("llm_message")
    if isinstance(llm_message, dict):
        text = content_to_text(llm_message.get("content"))
        if text.strip():
            return text
    for key in ("content", "message", "text", "action", "observation", "thought", "tool_result"):
        value = event.get(key)
        text = content_to_text(value)
        if text.strip():
            return text
    nested = event.get("data") or event.get("payload") or event.get("args")
    if isinstance(nested, dict):
        for key in ("content", "message", "text", "action", "observation", "thought", "tool_result"):
            text = content_to_text(nested.get(key))
            if text.strip():
                return text
    return ""
