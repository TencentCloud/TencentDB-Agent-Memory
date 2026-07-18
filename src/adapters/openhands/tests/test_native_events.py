import json

from tdai_openhands.native_events import load_native_events, messages_from_native_events


def _write_event(events_dir, index: int, payload: dict) -> None:
    events_dir.mkdir(parents=True, exist_ok=True)
    path = events_dir / f"event-{index:05d}-test.json"
    path.write_text(json.dumps(payload), encoding="utf-8")


def test_load_native_events_uses_compact_session_id_and_cursor(tmp_path) -> None:
    session_id = "abc-123"
    events_dir = tmp_path / "abc123" / "events"
    _write_event(events_dir, 0, {"llm_message": {"role": "user", "content": "one"}})
    _write_event(events_dir, 1, {"llm_message": {"role": "assistant", "content": "two"}})

    batch = load_native_events(
        session_id,
        since_index=1,
        conversations_dir=tmp_path,
    )

    assert len(batch.events) == 1
    assert batch.next_index == 2
    assert messages_from_native_events(batch.events) == [
        {"role": "assistant", "content": "two"}
    ]


def test_native_messages_ignore_extended_recall_context() -> None:
    messages = messages_from_native_events(
        [
            {
                "llm_message": {"role": "user", "content": "new question"},
                "extended_content": [
                    {
                        "type": "text",
                        "text": "<tdai_recall_context>do not capture</tdai_recall_context>",
                    }
                ],
            }
        ]
    )

    assert messages == [{"role": "user", "content": "new question"}]


def test_native_messages_preserve_event_timestamp_for_incremental_capture() -> None:
    messages = messages_from_native_events(
        [
            {
                "timestamp": "2026-07-16T06:59:38+00:00",
                "llm_message": {"role": "assistant", "content": "done"},
            }
        ]
    )

    assert messages == [
        {
            "role": "assistant",
            "content": "done",
            "timestamp": 1784185178000,
        }
    ]
