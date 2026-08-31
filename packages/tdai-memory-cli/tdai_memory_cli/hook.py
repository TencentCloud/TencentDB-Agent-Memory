from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from time import time
from typing import Any, Callable

from .__main__ import run_cli

HookRunner = Callable[[list[str], dict[str, str] | None, str | None], dict[str, Any]]


def main(argv: list[str] | None = None) -> int:
    result = run_hook(argv)
    if result.get("stdout"):
        print(result["stdout"])
    if result.get("stderr"):
        print(result["stderr"], file=sys.stderr)
    return int(result["code"])


def run_hook(
    argv: list[str] | None = None,
    *,
    stdin: str | None = None,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    cli_runner: HookRunner | None = None,
) -> dict[str, Any]:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        source_env = env if env is not None else os.environ
        event = _read_event(stdin)
        cli_args = _build_cli_args(args.command, event)
        _write_log(source_env, {
            "phase": "prepared",
            "command": args.command,
            "cli_args": cli_args,
            "event_keys": sorted(event.keys()),
        })
        runner = cli_runner or _run_cli
        result = runner(cli_args, source_env, cwd)
        _write_log(source_env, {
            "phase": "completed",
            "command": args.command,
            "result_code": result.get("code"),
        })
        if result.get("code", 1) == 0:
            return _adapt_hook_result(args.command, result, event=event, env=source_env)
        if _strict(source_env):
            return _adapt_hook_result(args.command, result, event=event, env=source_env)
        if _requires_json_stdout(args.command):
            return {
                "code": 0,
                "stdout": _continue_json(args.command, event=event, env=source_env),
                "stderr": result.get("stderr") or result.get("stdout") or "TDAI memory hook failed",
            }
        return {
            "code": 0,
            "stderr": result.get("stderr") or result.get("stdout") or "TDAI memory hook failed",
        }
    except SystemExit as error:
        return {"code": int(error.code)}
    except Exception as error:
        _write_log(env if env is not None else os.environ, {
            "phase": "error",
            "error": str(error),
        })
        if _strict(env if env is not None else os.environ):
            return {"code": 1, "stderr": f"TDAI memory hook failed: {error}"}
        return {"code": 0, "stderr": f"TDAI memory hook skipped: {error}"}


def _run_cli(argv: list[str], env: dict[str, str] | None, cwd: str | None) -> dict[str, Any]:
    return run_cli(argv, env=env, cwd=cwd)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tdai-memory-hook")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("prefetch", help="Read a user-prompt hook event and call tdai-memory prefetch.")
    subparsers.add_parser("sync-turn", help="Read a stop hook event and call tdai-memory sync-turn.")
    subparsers.add_parser("end-session", help="Read a session-end hook event and call tdai-memory end-session.")
    subparsers.add_parser("session-start", help="Read a session-start hook event and call tdai-memory session-start.")
    return parser


def _adapt_hook_result(
    command: str,
    result: dict[str, Any],
    *,
    event: dict[str, Any],
    env: dict[str, str] | None,
) -> dict[str, Any]:
    if not _requires_json_stdout(command):
        return result
    adapted = {
        "code": result.get("code", 0),
        "stdout": _continue_json(command, event=event, env=env),
    }
    if result.get("stderr"):
        adapted["stderr"] = result["stderr"]
    return adapted


def _requires_json_stdout(command: str) -> bool:
    return command in {"sync-turn", "end-session", "session-start"}


def _continue_json(
    command: str = "",
    *,
    event: dict[str, Any] | None = None,
    env: dict[str, str] | None = None,
) -> str:
    payload: dict[str, Any] = {"continue": True}
    return json.dumps(payload, separators=(",", ":"))


def _read_event(stdin: str | None) -> dict[str, Any]:
    raw = sys.stdin.read() if stdin is None else stdin
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("hook stdin must be a JSON object")
    return parsed


def _build_cli_args(command: str, event: dict[str, Any]) -> list[str]:
    if command == "prefetch":
        return _prefetch_args(event)
    if command == "sync-turn":
        return _sync_turn_args(event)
    if command == "end-session":
        return _end_session_args(event)
    if command == "session-start":
        return _session_start_args(event)
    raise ValueError(f"Unknown hook command: {command}")


def _prefetch_args(event: dict[str, Any]) -> list[str]:
    query = _first_text(event, [
        ("prompt",),
        ("user_prompt",),
        ("userPrompt",),
        ("query",),
        ("input",),
        ("message",),
        ("text",),
    ])
    if not query:
        raise ValueError("prefetch hook event does not include a user prompt")
    args = ["prefetch", "--query", query]
    _append_common_identity_args(args, event)
    return args


def _sync_turn_args(event: dict[str, Any]) -> list[str]:
    messages = _messages_from_event(event)
    user_content = _first_text(event, [
        ("user_content",),
        ("userContent",),
        ("prompt",),
        ("user_prompt",),
        ("userPrompt",),
    ])
    assistant_content = _first_text(event, [
        ("assistant_content",),
        ("assistantContent",),
        ("assistant_response",),
        ("assistantResponse",),
        ("response",),
        ("completion",),
        ("output",),
    ])

    if (not user_content or not assistant_content) and messages:
        turn = _last_user_assistant_turn(messages)
        user_content = user_content or turn[0]
        assistant_content = assistant_content or turn[1]

    if not user_content or not assistant_content:
        raise ValueError("sync-turn hook event does not include a complete user/assistant turn")

    args = [
        "sync-turn",
        "--user-content",
        user_content,
        "--assistant-content",
        assistant_content,
    ]
    _append_common_identity_args(args, event)
    session_id = _session_id(event)
    if session_id:
        args.extend(["--session-id", session_id])
    if messages:
        args.extend(["--messages-json", json.dumps(messages, ensure_ascii=False, separators=(",", ":"))])
    return args


def _end_session_args(event: dict[str, Any]) -> list[str]:
    args = ["end-session"]
    _append_common_identity_args(args, event)
    return args


def _session_start_args(event: dict[str, Any]) -> list[str]:
    args = ["session-start"]
    user_id = _first_text(event, [("user_id",), ("userId",), ("user", "id")])
    if user_id:
        args.extend(["--user-id", user_id])
    return args


def _append_common_identity_args(args: list[str], event: dict[str, Any]) -> None:
    session_key = _session_key(event)
    if session_key:
        args.extend(["--session-key", session_key])
    user_id = _first_text(event, [("user_id",), ("userId",), ("user", "id")])
    if user_id:
        args.extend(["--user-id", user_id])


def _session_key(event: dict[str, Any]) -> str:
    return _first_text(event, [
        ("session_key",),
        ("sessionKey",),
        ("session_id",),
        ("sessionId",),
        ("conversation_id",),
        ("conversationId",),
        ("thread_id",),
        ("threadId",),
    ])


def _session_id(event: dict[str, Any]) -> str:
    return _first_text(event, [("session_id",), ("sessionId",)])


def _messages_from_event(event: dict[str, Any]) -> list[dict[str, str]]:
    direct = _first_list(event, [("messages",), ("conversation",), ("transcript",)])
    if direct:
        return _normalize_messages(direct)
    transcript_path = _first_text(event, [
        ("transcript_path",),
        ("transcriptPath",),
        ("conversation_path",),
        ("conversationPath",),
    ])
    if not transcript_path:
        return []
    return _load_transcript(Path(transcript_path))


def _load_transcript(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
        return _messages_from_json_value(parsed)
    except json.JSONDecodeError:
        messages: list[Any] = []
        for line in raw.splitlines():
            if not line.strip():
                continue
            try:
                messages.extend(_messages_from_json_value(json.loads(line)))
            except json.JSONDecodeError:
                continue
        return _normalize_messages(messages)


def _messages_from_json_value(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if not isinstance(value, dict):
        return []
    for key in ("messages", "conversation", "transcript"):
        item = value.get(key)
        if isinstance(item, list):
            return item
    message = value.get("message")
    if isinstance(message, dict):
        return [message]
    codex_message = _message_from_codex_transcript_entry(value)
    if codex_message:
        return [codex_message]
    return [value]


def _message_from_codex_transcript_entry(value: dict[str, Any]) -> dict[str, Any]:
    entry_type = _string_value(value.get("type"))
    payload = value.get("payload")
    if not isinstance(payload, dict):
        return {}

    if entry_type == "response_item" and payload.get("type") == "message":
        role = _string_value(payload.get("role"))
        if role in {"user", "assistant", "system", "tool", "developer"}:
            return {"role": role, "content": payload.get("content")}

    if entry_type == "event_msg":
        event_type = _string_value(payload.get("type"))
        if event_type == "user_message":
            return {"role": "user", "content": payload.get("message")}
        if event_type == "agent_message":
            return {"role": "assistant", "content": payload.get("message")}

    return {}


def _normalize_messages(values: list[Any]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for item in values:
        if not isinstance(item, dict):
            continue
        role = _role_from_item(item)
        text = _content_from_item(item)
        if role and text:
            messages.append({"role": role, "content": text})
    return messages


def _role_from_item(item: dict[str, Any]) -> str:
    role = _string_value(item.get("role")) or _string_value(item.get("type")) or _string_value(item.get("speaker"))
    if role in {"human", "user_message"}:
        return "user"
    if role in {"ai", "assistant_message"}:
        return "assistant"
    return role if role in {"user", "assistant", "system", "tool"} else ""


def _content_from_item(item: dict[str, Any]) -> str:
    for key in ("content", "text", "message"):
        value = item.get(key)
        if isinstance(value, dict):
            nested = _content_from_item(value)
            if nested:
                return nested
        text = _text_from_value(value)
        if text:
            return text
    return ""


def _last_user_assistant_turn(messages: list[dict[str, str]]) -> tuple[str, str]:
    assistant = ""
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if not assistant and message.get("role") == "assistant":
            assistant = message.get("content", "")
            continue
        if assistant and message.get("role") == "user":
            return message.get("content", ""), assistant
    return "", assistant


def _first_text(data: dict[str, Any], paths: list[tuple[str, ...]]) -> str:
    for path in paths:
        value = _value_at_path(data, path)
        text = _text_from_value(value)
        if text:
            return text
    return ""


def _first_list(data: dict[str, Any], paths: list[tuple[str, ...]]) -> list[Any]:
    for path in paths:
        value = _value_at_path(data, path)
        if isinstance(value, list):
            return value
    return []


def _value_at_path(data: dict[str, Any], path: tuple[str, ...]) -> Any:
    current: Any = data
    for part in path:
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def _text_from_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = []
        for item in value:
            text = _text_from_value(item)
            if text:
                parts.append(text)
        return "\n".join(parts).strip()
    if isinstance(value, dict):
        if _string_value(value.get("type")) == "text":
            return _text_from_value(value.get("text"))
        for key in ("text", "content", "message"):
            text = _text_from_value(value.get(key))
            if text:
                return text
    return ""


def _string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _strict(env: dict[str, str] | os._Environ[str]) -> bool:
    return str(env.get("TDAI_HOOK_STRICT", "")).strip().lower() in {"1", "true", "yes", "on"}


def _write_log(env: dict[str, str] | os._Environ[str], payload: dict[str, Any]) -> None:
    path = str(env.get("TDAI_HOOK_LOG", "")).strip()
    if not path:
        return
    entry = {"ts": time(), **payload}
    try:
        with Path(path).expanduser().open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        pass


if __name__ == "__main__":
    raise SystemExit(main())
