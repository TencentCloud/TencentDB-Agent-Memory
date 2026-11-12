#!/usr/bin/env python3
"""Whale Stop hook: capture the last user/assistant turn and send it to the
TdaiGateway for memory storage (non-blocking background thread).

Whale's Stop payload includes last_assistant_text directly, so no transcript
parsing is required (simpler than Codex). Reads hook payload as JSON on stdin.
"""
import json
import os
import sys
import threading
import urllib.request

GATEWAY = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")


def capture(session_id: str, prompt: str, assistant_text: str) -> None:
    # Gateway /capture expects snake_case fields.
    body = json.dumps({
        "user_content": prompt,
        "assistant_content": assistant_text,
        "session_key": session_id,
    }).encode()
    req = urllib.request.Request(
        f"{GATEWAY}/capture",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=25)
    except Exception:
        pass  # fail silently


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    session_id = payload.get("session_id", "")
    last_assistant = payload.get("last_assistant_text", "")
    prompt = payload.get("prompt", "")
    if not prompt and not last_assistant:
        return

    # Non-blocking so Whale's turn-end is never delayed.
    threading.Thread(
        target=capture,
        args=(session_id, prompt, last_assistant),
        daemon=True,
    ).start()


if __name__ == "__main__":
    main()
