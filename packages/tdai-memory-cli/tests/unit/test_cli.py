from tdai_memory_cli.__main__ import run_cli


class FakeRequester:
    def __init__(self):
        self.calls = []

    def __call__(self, _config, path, *, body=None, method="POST", **_kwargs):
        self.calls.append((path, method, body))
        if path == "/health":
            return {"status": "ok"}
        if path == "/recall":
            return {"context": "remembered context", "strategy": "hybrid", "memory_count": 1}
        if path == "/capture":
            return {"l0_recorded": 2, "scheduler_notified": True}
        if path == "/session/end":
            return {"flushed": True}
        raise AssertionError(f"unexpected path: {path}")


ENV = {
    "TDAI_GATEWAY_URL": "http://127.0.0.1:8420",
    "TDAI_SESSION_KEY": "session:default",
    "TDAI_USER_ID": "user:default",
}


def test_prefetch_maps_to_recall():
    requester = FakeRequester()
    result = run_cli(
        ["prefetch", "--query", "what do I prefer?"],
        env=ENV,
        request_func=requester,
    )

    assert result["code"] == 0
    assert "remembered context" in result["stdout"]
    assert requester.calls[0] == ("/health", "GET", None)
    assert requester.calls[1] == ("/recall", "POST", {
        "query": "what do I prefer?",
        "session_key": "session:default",
        "user_id": "user:default",
    })


def test_sync_turn_maps_to_capture():
    requester = FakeRequester()
    result = run_cli([
        "sync-turn",
        "--user-content",
        "hello",
        "--assistant-content",
        "world",
        "--session-key",
        "session:explicit",
        "--messages-json",
        '[{"role":"user","content":"hello"}]',
    ], env=ENV, request_func=requester)

    assert result["code"] == 0
    assert "l0_recorded: 2" in result["stdout"]
    assert requester.calls[0] == ("/health", "GET", None)
    assert requester.calls[1] == ("/capture", "POST", {
        "user_content": "hello",
        "assistant_content": "world",
        "session_key": "session:explicit",
        "session_id": "",
        "user_id": "user:default",
        "messages": [{"role": "user", "content": "hello"}],
    })


def test_end_session_maps_to_session_end():
    requester = FakeRequester()
    result = run_cli(
        ["end-session", "--user-id", "user:explicit"],
        env=ENV,
        request_func=requester,
    )

    assert result["code"] == 0
    assert "flushed: true" in result["stdout"]
    assert requester.calls[0] == ("/health", "GET", None)
    assert requester.calls[1] == ("/session/end", "POST", {
        "session_key": "session:default",
        "user_id": "user:explicit",
    })


def test_session_start_checks_gateway_only():
    requester = FakeRequester()
    result = run_cli(
        ["session-start", "--user-id", "codex"],
        env=ENV,
        request_func=requester,
    )

    assert result["code"] == 0
    assert "session_start: ok" in result["stdout"]
    assert "gateway: already-running" in result["stdout"]
    assert "agents_md:" not in result["stdout"]
    assert requester.calls[0] == ("/health", "GET", None)
