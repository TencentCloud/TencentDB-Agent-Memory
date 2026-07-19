import json
from pathlib import Path

from tdai_memory_cli.hook import run_hook


def _runner(calls):
    def run(argv, env, cwd):
        calls.append((argv, env, cwd))
        return {"code": 0, "stdout": "ok"}

    return run


def test_prefetch_reads_prompt_from_stdin_json():
    calls = []
    result = run_hook(
        ["prefetch"],
        stdin=json.dumps({"prompt": "remember me", "session_id": "session:1", "user_id": "user:1"}),
        env={},
        cwd="/repo",
        cli_runner=_runner(calls),
    )

    assert result == {"code": 0, "stdout": "ok"}
    assert calls[0][0] == [
        "prefetch",
        "--query",
        "remember me",
        "--session-key",
        "session:1",
        "--user-id",
        "user:1",
    ]


def test_sync_turn_reads_direct_turn_fields():
    calls = []
    result = run_hook(
        ["sync-turn"],
        stdin=json.dumps({
            "user_content": "hello",
            "assistant_content": "world",
            "sessionKey": "session:2",
        }),
        env={},
        cli_runner=_runner(calls),
    )

    assert result["code"] == 0
    assert calls[0][0] == [
        "sync-turn",
        "--user-content",
        "hello",
        "--assistant-content",
        "world",
        "--session-key",
        "session:2",
    ]
    hook_output = json.loads(result["stdout"])
    assert hook_output["continue"] is True
    assert "hookSpecificOutput" not in hook_output


def test_sync_turn_reads_last_turn_from_transcript_path(tmp_path: Path):
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text(
        "\n".join([
            json.dumps({"role": "user", "content": "old"}),
            json.dumps({"role": "assistant", "content": "old answer"}),
            json.dumps({"role": "user", "content": "current question"}),
            json.dumps({"role": "assistant", "content": "current answer"}),
        ]),
        encoding="utf-8",
    )
    calls = []

    result = run_hook(
        ["sync-turn"],
        stdin=json.dumps({"transcript_path": str(transcript), "session_id": "session:3"}),
        env={},
        cli_runner=_runner(calls),
    )

    assert result["code"] == 0
    argv = calls[0][0]
    assert argv[:7] == [
        "sync-turn",
        "--user-content",
        "current question",
        "--assistant-content",
        "current answer",
        "--session-key",
        "session:3",
    ]
    assert "--messages-json" in argv


def test_sync_turn_reads_codex_transcript_jsonl(tmp_path: Path):
    transcript = tmp_path / "codex-transcript.jsonl"
    transcript.write_text(
        "\n".join([
            json.dumps({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "codex question"}],
                },
            }),
            json.dumps({
                "type": "event_msg",
                "payload": {
                    "type": "agent_message",
                    "message": "codex answer",
                    "phase": "final_answer",
                },
            }),
        ]),
        encoding="utf-8",
    )
    calls = []

    result = run_hook(
        ["sync-turn"],
        stdin=json.dumps({"transcript_path": str(transcript), "session_id": "codex-session"}),
        env={},
        cli_runner=_runner(calls),
    )

    assert result["code"] == 0
    argv = calls[0][0]
    assert argv[:7] == [
        "sync-turn",
        "--user-content",
        "codex question",
        "--assistant-content",
        "codex answer",
        "--session-key",
        "codex-session",
    ]


def test_end_session_uses_session_key():
    calls = []
    result = run_hook(
        ["end-session"],
        stdin=json.dumps({"session_id": "session:end"}),
        env={},
        cli_runner=_runner(calls),
    )

    assert result["code"] == 0
    assert calls[0][0] == ["end-session", "--session-key", "session:end"]


def test_session_start_reads_user_id():
    calls = []
    result = run_hook(
        ["session-start"],
        stdin=json.dumps({"agents_path": "/repo/AGENTS.md", "user_id": "codex-user"}),
        env={},
        cli_runner=_runner(calls),
    )

    assert result["code"] == 0
    hook_output = json.loads(result["stdout"])
    assert hook_output["continue"] is True
    assert "hookSpecificOutput" not in hook_output
    assert calls[0][0] == [
        "session-start",
        "--user-id",
        "codex-user",
    ]


def test_hook_is_non_blocking_by_default_on_cli_failure():
    def fail(_argv, _env, _cwd):
        return {"code": 1, "stderr": "gateway down"}

    result = run_hook(
        ["prefetch"],
        stdin=json.dumps({"prompt": "q"}),
        env={},
        cli_runner=fail,
    )

    assert result == {"code": 0, "stderr": "gateway down"}


def test_hook_can_be_strict():
    def fail(_argv, _env, _cwd):
        return {"code": 1, "stderr": "gateway down"}

    result = run_hook(
        ["prefetch"],
        stdin=json.dumps({"prompt": "q"}),
        env={"TDAI_HOOK_STRICT": "1"},
        cli_runner=fail,
    )

    assert result == {"code": 1, "stderr": "gateway down"}
