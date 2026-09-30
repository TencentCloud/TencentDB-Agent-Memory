from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from .client import TdaiGatewayClient
from .config import TdaiOpenHandsConfig, load_config
from .events import summarize_events
from .hook_state import HookSessionState, HookStateStore, current_time_millis
from .native_events import (
    load_native_events,
    messages_from_native_events,
    native_event_count,
    openhands_conversations_dir,
)
from .prompt import compose_recall_context
from .session import hook_session_key
from .utils import truncate_text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TencentDB memory hooks for OpenHands.")
    parser.add_argument(
        "--tdai-config",
        default=os.getenv("TDAI_OPENHANDS_CONFIG"),
        help="Path to the TDAI OpenHands YAML/JSON config.",
    )
    args = parser.parse_args(argv)
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("OpenHands hook input must be a JSON object")
        output = handle_hook_event(payload, load_config(args.tdai_config))
        if output:
            json.dump(output, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
        return 0
    except Exception as exc:
        # Hook failures must not block an OpenHands task.
        print(f"[tdai-openhands] hook failed open: {exc}", file=sys.stderr)
        return 0


def handle_hook_event(
    event: dict[str, Any],
    config: TdaiOpenHandsConfig,
    *,
    client: TdaiGatewayClient | None = None,
    state_store: HookStateStore | None = None,
) -> dict[str, Any]:
    if not config.enabled or not config.lifecycle.enabled:
        return {}
    event_type = str(event.get("event_type") or os.getenv("OPENHANDS_EVENT_TYPE") or "")
    session_id = str(event.get("session_id") or os.getenv("OPENHANDS_SESSION_ID") or "").strip()
    working_dir = str(event.get("working_dir") or os.getenv("OPENHANDS_PROJECT_DIR") or os.getcwd())
    if not session_id:
        return {}

    client = client or TdaiGatewayClient(config.gateway)
    state_store = state_store or HookStateStore(config.lifecycle.state_dir)
    session_key = hook_session_key(config.lifecycle.session_key_prefix, session_id)
    conversations_dir = openhands_conversations_dir(config.lifecycle.conversations_dir)

    if event_type == "SessionStart":
        if state_store.load(session_id) is None:
            state_store.save(
                HookSessionState(
                    session_id=session_id,
                    session_key=session_key,
                    next_event_index=native_event_count(
                        session_id,
                        conversations_dir=conversations_dir,
                    ),
                    started_at=current_time_millis(),
                )
            )
        return {}
    if event_type == "UserPromptSubmit":
        return _recall_for_prompt(
            event=event,
            working_dir=working_dir,
            session_key=session_key,
            config=config,
            client=client,
        )
    if event_type == "Stop" and config.lifecycle.capture_on_stop:
        _capture_pending(
            session_id=session_id,
            session_key=session_key,
            working_dir=working_dir,
            conversations_dir=conversations_dir,
            config=config,
            client=client,
            state_store=state_store,
        )
        return {}
    if event_type == "SessionEnd":
        capture_ok = True
        if config.lifecycle.capture_on_session_end:
            capture_ok = _capture_all_pending(
                session_id=session_id,
                session_key=session_key,
                working_dir=working_dir,
                conversations_dir=conversations_dir,
                config=config,
                client=client,
                state_store=state_store,
            )
        flush_ok = True
        if config.lifecycle.flush_on_session_end:
            flush = client.session_end(
                session_key=session_key,
                user_id=config.session.user_id,
            )
            flush_ok = "_tdai_error" not in flush
        if capture_ok and flush_ok:
            state_store.delete(session_id)
        return {}
    return {}


def _capture_all_pending(
    *,
    session_id: str,
    session_key: str,
    working_dir: str,
    conversations_dir: Path,
    config: TdaiOpenHandsConfig,
    client: TdaiGatewayClient,
    state_store: HookStateStore,
) -> bool:
    """Drain all persisted native events before flushing a closed session."""
    while True:
        state = state_store.load(session_id) or HookSessionState(
            session_id=session_id,
            session_key=session_key,
        )
        total = native_event_count(session_id, conversations_dir=conversations_dir)
        if state.next_event_index >= total:
            return True
        previous_index = state.next_event_index
        if not _capture_pending(
            session_id=session_id,
            session_key=session_key,
            working_dir=working_dir,
            conversations_dir=conversations_dir,
            config=config,
            client=client,
            state_store=state_store,
        ):
            return False
        updated = state_store.load(session_id)
        if updated is None or updated.next_event_index <= previous_index:
            return False


def _recall_for_prompt(
    *,
    event: dict[str, Any],
    working_dir: str,
    session_key: str,
    config: TdaiOpenHandsConfig,
    client: TdaiGatewayClient,
) -> dict[str, Any]:
    if not config.recall.enabled:
        return {}
    message = str(event.get("message") or "").strip()
    if not message:
        return {}
    query = (
        "Platform: OpenHands Terminal\n"
        f"Working directory: {working_dir}\n"
        "User request:\n"
        f"{message}"
    )
    recall = None
    l1_search = None
    if config.recall.include_gateway_recall:
        recall = client.recall(
            query=query,
            session_key=session_key,
            user_id=config.session.user_id,
        )
    if config.recall.include_l1_search:
        l1_search = client.search_memories(
            query=query,
            limit=config.recall.l1_search_limit,
        )
    context = compose_recall_context(
        recall=recall,
        l1_search=l1_search,
        config=config.recall,
        tool_bundle_enabled=config.tools.enabled,
    )
    return {"additionalContext": context} if context else {}


def _capture_pending(
    *,
    session_id: str,
    session_key: str,
    working_dir: str,
    conversations_dir: Path,
    config: TdaiOpenHandsConfig,
    client: TdaiGatewayClient,
    state_store: HookStateStore,
) -> bool:
    if not config.capture.enabled:
        return True
    state = state_store.load(session_id) or HookSessionState(
        session_id=session_id,
        session_key=session_key,
    )
    batch = load_native_events(
        session_id,
        since_index=state.next_event_index,
        conversations_dir=conversations_dir,
        max_events=config.lifecycle.max_capture_events,
    )
    if not batch.events:
        return True

    messages = messages_from_native_events(batch.events)
    message_timestamps = [
        int(item["timestamp"])
        for item in messages
        if isinstance(item.get("timestamp"), (int, float))
    ]
    started_at = state.started_at
    if started_at is None and message_timestamps:
        started_at = min(message_timestamps) - 1
    user_parts = [item["content"] for item in messages if item["role"] == "user"]
    assistant_parts = [
        item["content"] for item in messages if item["role"] == "assistant"
    ]
    if not user_parts and not assistant_parts:
        state.next_event_index = batch.next_index
        state_store.save(state)
        return True

    user_content = "\n\n".join(user_parts) or (
        f"OpenHands continued an existing task in {working_dir}."
    )
    assistant_text = "\n\n".join(assistant_parts) or (
        "OpenHands ended the turn without a textual assistant response."
    )
    event_summary = summarize_events(
        batch.events,
        max_chars=config.capture.max_assistant_summary_chars,
    )
    assistant_content = truncate_text(
        f"{assistant_text}\n\n{event_summary}",
        config.capture.max_assistant_summary_chars,
    )
    result = client.capture(
        user_content=truncate_text(user_content, config.capture.max_assistant_summary_chars),
        assistant_content=assistant_content,
        session_key=session_key,
        session_id=session_id,
        user_id=config.session.user_id,
        messages=messages[-40:] if config.capture.include_messages else None,
        started_at=started_at,
    )
    if "_tdai_error" in result.raw:
        return False
    state.next_event_index = batch.next_index
    state.session_key = session_key
    state_store.save(state)
    return True


if __name__ == "__main__":
    raise SystemExit(main())
