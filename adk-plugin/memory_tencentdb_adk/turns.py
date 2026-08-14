"""Pure helpers that turn ADK session events into Gateway capture payloads.

The Gateway's ``POST /capture`` endpoint persists one *completed turn* —
a user message plus the assistant response it produced. ADK sessions are
flat event lists (user events, agent events, tool calls/responses), so
this module pairs them up.

Deliberately dependency-free: events are duck-typed (``author``,
``content.parts[].text``, ``timestamp``, ``id``) so the pairing logic can
be unit-tested without ``google-adk`` installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Sequence

USER_AUTHOR = "user"


@dataclass
class Turn:
    """One completed user/assistant exchange extracted from a session."""

    user_text: str
    assistant_text: str
    #: ``[{"role": ..., "content": ...}, ...]`` in event order, for /capture.
    messages: List[Dict[str, Any]] = field(default_factory=list)
    #: IDs of every event folded into this turn (for idempotent re-capture).
    event_ids: List[str] = field(default_factory=list)


def text_of_event(event: Any) -> str:
    """Concatenated text of all text parts of an event ("" when none).

    Non-text parts (function calls, function responses, inline data) are
    ignored — the memory pipeline works on natural-language content.
    """
    content = getattr(event, "content", None)
    parts = getattr(content, "parts", None) if content is not None else None
    if not parts:
        return ""
    texts = [part.text for part in parts if getattr(part, "text", None)]
    return "\n".join(text.strip() for text in texts if text and text.strip())


def pair_turns(events: Sequence[Any]) -> List[Turn]:
    """Pair a flat event list into completed user→assistant turns.

    Rules (chosen to match how the OpenClaw plugin and the Hermes provider
    feed the same pipeline):

    - An event authored by ``"user"`` opens a new turn (a later user event
      before any assistant reply replaces the pending one — the pipeline
      only wants turns that actually produced a response).
    - Every non-user event with text after an open turn contributes to that
      turn's assistant side; multiple agent events are joined with blank
      lines (multi-agent runs produce several authored events per turn).
    - Events with no text (pure tool traffic) are skipped.
    - A turn is emitted once the next user event arrives or the list ends,
      and only when both sides are non-empty (``/capture`` requires both).
    """
    turns: List[Turn] = []
    pending_user: str = ""
    pending_user_ids: List[str] = []
    assistant_chunks: List[str] = []
    assistant_ids: List[str] = []
    messages: List[Dict[str, Any]] = []

    def flush() -> None:
        nonlocal pending_user, pending_user_ids, assistant_chunks, assistant_ids, messages
        if pending_user and assistant_chunks:
            turns.append(
                Turn(
                    user_text=pending_user,
                    assistant_text="\n\n".join(assistant_chunks),
                    messages=messages,
                    event_ids=pending_user_ids + assistant_ids,
                )
            )
        pending_user = ""
        pending_user_ids = []
        assistant_chunks = []
        assistant_ids = []
        messages = []

    for event in events:
        text = text_of_event(event)
        if not text:
            continue
        author = getattr(event, "author", "") or ""
        event_id = str(getattr(event, "id", "") or "")

        if author == USER_AUTHOR:
            flush()
            pending_user = text
            pending_user_ids = [event_id] if event_id else []
            messages = [{"role": "user", "content": text}]
        elif pending_user:
            assistant_chunks.append(text)
            if event_id:
                assistant_ids.append(event_id)
            messages.append({"role": "assistant", "content": text})
        # Assistant text before any user message has no turn to attach to —
        # skip it (greeting banners, warm-up messages).

    flush()
    return turns
