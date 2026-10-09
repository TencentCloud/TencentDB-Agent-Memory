import json

from tdai_openhands.client import CaptureResult, MemorySearchResult, RecallResult
from tdai_openhands.config import TdaiOpenHandsConfig
from tdai_openhands.hook_entry import handle_hook_event
from tdai_openhands.hook_state import HookStateStore


class FakeClient:
    def __init__(self) -> None:
        self.captures = []
        self.ended = []

    def recall(self, **kwargs):
        return RecallResult(context="<user-persona>prefer focused tests</user-persona>")

    def search_memories(self, **kwargs):
        return MemorySearchResult(results="Run the failing test before editing.", total=1)

    def capture(self, **kwargs):
        self.captures.append(kwargs)
        return CaptureResult(l0_recorded=2, raw={"l0_recorded": 2})

    def session_end(self, **kwargs):
        self.ended.append(kwargs)
        return {"ok": True}


def _write_event(root, session_id: str, index: int, role: str, content: str) -> None:
    events = root / session_id.replace("-", "") / "events"
    events.mkdir(parents=True, exist_ok=True)
    (events / f"event-{index:05d}-test.json").write_text(
        json.dumps({"llm_message": {"role": role, "content": content}}),
        encoding="utf-8",
    )


def _config(tmp_path) -> TdaiOpenHandsConfig:
    config = TdaiOpenHandsConfig()
    config.lifecycle.conversations_dir = str(tmp_path / "conversations")
    config.lifecycle.state_dir = str(tmp_path / "state")
    config.lifecycle.max_capture_events = 1
    config.tools.enabled = True
    return config


def test_user_prompt_submit_returns_recalled_context(tmp_path) -> None:
    config = _config(tmp_path)
    output = handle_hook_event(
        {
            "event_type": "UserPromptSubmit",
            "session_id": "session-1",
            "working_dir": "/testbed",
            "message": "Fix the failing test",
        },
        config,
        client=FakeClient(),
        state_store=HookStateStore(config.lifecycle.state_dir),
    )

    assert "additionalContext" in output
    assert "Run the failing test before editing" in output["additionalContext"]
    assert "<user-persona>" in output["additionalContext"]


def test_stop_captures_turn_and_session_end_drains_remaining_events(tmp_path) -> None:
    config = _config(tmp_path)
    client = FakeClient()
    store = HookStateStore(config.lifecycle.state_dir)
    base_event = {
        "session_id": "session-1",
        "working_dir": "/testbed",
    }
    handle_hook_event(
        {**base_event, "event_type": "SessionStart"},
        config,
        client=client,
        state_store=store,
    )
    conversations = tmp_path / "conversations"
    _write_event(conversations, "session-1", 0, "user", "Fix the bug")
    _write_event(conversations, "session-1", 1, "assistant", "I inspected the code")

    handle_hook_event(
        {**base_event, "event_type": "Stop"},
        config,
        client=client,
        state_store=store,
    )
    assert len(client.captures) == 1

    handle_hook_event(
        {**base_event, "event_type": "SessionEnd"},
        config,
        client=client,
        state_store=store,
    )
    assert len(client.captures) == 2
    assert client.captures[0]["user_content"] == "Fix the bug"
    assert client.captures[0]["started_at"] is not None
    assert "I inspected the code" in client.captures[1]["assistant_content"]
    assert client.ended
    assert store.load("session-1") is None
