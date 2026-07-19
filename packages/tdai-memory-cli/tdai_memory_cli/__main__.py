from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .config import load_config
from .formatters import format_capture, format_error, format_recall, format_session_end
from .gateway_start import ensure_gateway_running
from .gateway_http import request_json
from .runtime import touch_heartbeat
from .session import resolve_session_key


def main(argv: list[str] | None = None) -> int:
    result = run_cli(argv)
    if result.get("stdout"):
        print(result["stdout"])
    if result.get("stderr"):
        print(result["stderr"], file=sys.stderr)
    return int(result["code"])


def run_cli(
    argv: list[str] | None = None,
    *,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    request_func: Any | None = None,
) -> dict[str, Any]:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
        config = load_config(env=env, cwd=cwd)
        send_request = request_func or request_json
        if args.command == "prefetch":
            session_key = resolve_session_key(args.session_key, config.default_session_key)
            touch_heartbeat(config, session_key=session_key, user_id=args.user_id or config.user_id)
            ensure_gateway_running(config, request_func=send_request)
            return {
                "code": 0,
                "stdout": format_recall(send_request(config, "/recall", body={
                    "query": args.query,
                    "session_key": session_key,
                    "user_id": args.user_id or config.user_id,
                })),
            }
        if args.command == "sync-turn":
            session_key = resolve_session_key(args.session_key, config.default_session_key)
            touch_heartbeat(config, session_key=session_key, user_id=args.user_id or config.user_id)
            ensure_gateway_running(config, request_func=send_request)
            return {
                "code": 0,
                "stdout": format_capture(send_request(config, "/capture", body={
                    "user_content": args.user_content,
                    "assistant_content": args.assistant_content,
                    "session_key": session_key,
                    "session_id": args.session_id or "",
                    "user_id": args.user_id or config.user_id,
                    "messages": _read_messages(args),
                })),
            }
        if args.command == "end-session":
            session_key = resolve_session_key(args.session_key, config.default_session_key)
            touch_heartbeat(config, session_key=session_key, user_id=args.user_id or config.user_id)
            ensure_gateway_running(config, request_func=send_request)
            return {
                "code": 0,
                "stdout": format_session_end(send_request(config, "/session/end", body={
                    "session_key": session_key,
                    "user_id": args.user_id or config.user_id,
                })),
            }
        if args.command == "session-start":
            touch_heartbeat(config, user_id=args.user_id or config.user_id)
            gateway_status = ensure_gateway_running(config, request_func=send_request)
            return {
                "code": 0,
                "stdout": "\n".join([
                    "session_start: ok",
                    f"gateway: {gateway_status}",
                ]),
            }
        return {"code": 2, "stderr": f"Unknown command: {args.command}"}
    except SystemExit as error:
        return {"code": int(error.code)}
    except Exception as error:
        return {"code": 1, "stderr": format_error(error)}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tdai-memory")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prefetch = subparsers.add_parser("prefetch", help="Run Gateway /recall for pre-turn context.")
    prefetch.add_argument("--query", required=True)
    prefetch.add_argument("--session-key", default="")
    prefetch.add_argument("--user-id", default="")

    sync_turn = subparsers.add_parser("sync-turn", help="Run Gateway /capture for a completed turn.")
    sync_turn.add_argument("--user-content", required=True)
    sync_turn.add_argument("--assistant-content", required=True)
    sync_turn.add_argument("--session-key", default="")
    sync_turn.add_argument("--session-id", default="")
    sync_turn.add_argument("--user-id", default="")
    sync_turn.add_argument("--messages-json", default="")
    sync_turn.add_argument("--messages-file", default="")

    end_session = subparsers.add_parser("end-session", help="Run Gateway /session/end.")
    end_session.add_argument("--session-key", default="")
    end_session.add_argument("--user-id", default="")

    session_start = subparsers.add_parser("session-start", help="Ensure Gateway is running.")
    session_start.add_argument("--user-id", default="")

    return parser


def _read_messages(args: argparse.Namespace) -> list[Any] | None:
    if args.messages_json and args.messages_file:
        raise ValueError("Use only one of --messages-json or --messages-file")
    if not args.messages_json and not args.messages_file:
        return None
    raw = args.messages_json or Path(args.messages_file).read_text(encoding="utf-8")
    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise ValueError("messages must be a JSON array")
    return parsed


if __name__ == "__main__":
    raise SystemExit(main())
