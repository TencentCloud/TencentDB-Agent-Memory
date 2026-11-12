#!/usr/bin/env python3
"""Whale UserPromptSubmit hook: recall relevant memories from the TdaiGateway
and return them as additional_context for Whale to inject.

Reads the hook payload as JSON on stdin, calls Gateway /recall, and prints a
JSON result. Fails silently (exit 0, no output) so the user is never blocked.
"""
import json
import os
import sys
import urllib.request

GATEWAY = os.environ.get("TDAI_GATEWAY_URL", "http://127.0.0.1:8420")


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return

    prompt = payload.get("prompt", "")
    session_id = payload.get("session_id", "")
    if not prompt:
        return

    body = json.dumps({"query": prompt, "session_key": session_id}).encode()
    req = urllib.request.Request(
        f"{GATEWAY}/recall",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            result = json.loads(resp.read())
        context = result.get("context", "")
        if context:
            print(json.dumps({
                "decision": "pass",
                "additional_context": f"## Memory Context\n{context}",
            }))
    except Exception:
        pass  # fail silently — memory is an enhancement, not a critical path


if __name__ == "__main__":
    main()
