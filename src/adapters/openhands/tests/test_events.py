from tdai_openhands.events import summarize_events


def test_summarize_events() -> None:
    summary = summarize_events([{"source": "agent", "content": "done"}], max_chars=1000)
    assert "OpenHands run finished" in summary
    assert "done" in summary


def test_summarize_events_reads_native_llm_message() -> None:
    summary = summarize_events(
        [{"source": "agent", "llm_message": {"content": "fixed the bug"}}],
        max_chars=1000,
    )
    assert "fixed the bug" in summary
