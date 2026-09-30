#!/usr/bin/env python3
"""Verify a Panel-created Agent/Task can write L0 through Proxy and read it in Panel."""

import argparse
import json
from pathlib import Path
import stat
import time
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import uuid4


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _new_url):
        return None


opener = build_opener(ProxyHandler({}), NoRedirect)


def post(url, headers, body):
    request = Request(
        url, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    try:
        with opener.open(request, timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            envelope = json.load(error)
            detail = f"code={envelope.get('code')} request_id={envelope.get('request_id')}"
        except (ValueError, UnicodeDecodeError):
            detail = "no JSON error envelope"
        raise RuntimeError(f"HTTP {error.code} from {url}: {detail}") from None


def panel_action(base, action, headers, body):
    result = post(f"{base}/api/v1/chat-memory/{action}", headers, body)
    if result.get("code") != 0:
        raise RuntimeError(
            f"Panel {action} failed: code={result.get('code')} "
            f"request_id={result.get('request_id')}"
        )
    return result["data"]


def has_current_turns(items, user_turn, assistant_turn, session_id):
    if not session_id:
        return False
    # Panel's existing L0 title carries the Core session_id; role and body alone
    # cannot associate two matching records with this Proxy initialization.
    return all(any(
        item.get("role") == role
        and item.get("body") == body
        and item.get("title") == f"{role} @ {session_id}"
        for item in items
    ) for role, body in (("user", user_turn), ("assistant", assistant_turn)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--panel-url", required=True, help="Control API base URL")
    parser.add_argument("--proxy-url", required=True, help="Proxy base URL, without agent path")
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--team-id", required=True)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args()

    for label, value in (("panel", args.panel_url), ("proxy", args.proxy_url)):
        parsed = urlparse(value)
        if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            parser.error(f"{label} URL must be an HTTP loopback address without credentials or query")

    if stat.S_IMODE(args.key_file.stat().st_mode) & 0o077:
        parser.error("key file must not be readable by group or others (chmod 600)")
    key = args.key_file.read_text().strip()
    if not key.startswith("sk-mem-"):
        parser.error("key file must contain a Memory User Key")

    panel_headers = {
        "content-type": "application/json",
        "x-tdai-service-id": args.instance_id,
        "x-tdai-user-key": key,
    }
    blocks = panel_action(
        args.panel_url.rstrip("/"), "my-agents", panel_headers, {"team_id": args.team_id}
    )["items"]
    block_id = f"chat_memory-{args.team_id}-{args.agent_id}"
    if not any(block.get("id") == block_id for block in blocks):
        raise RuntimeError("Panel cannot see the selected Agent's Chat Memory block")

    marker = f"ON05 onboarding smoke {uuid4().hex}"
    session_id = f"onboarding-{uuid4().hex}"
    expected_reply = f"Onboarding fake model response: {marker}"
    proxy_headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {key}",
        "x-tdai-user-key": key,
        "x-team-id": args.team_id,
        "x-agent-id": args.agent_id,
        "x-task-id": args.task_id,
        "x-conversation-id": session_id,
    }
    response = post(
        f"{args.proxy_url.rstrip('/')}/opencode/{args.instance_id}/v1/chat/completions",
        proxy_headers,
        {"model": "onboarding-fake-model", "messages": [{"role": "user", "content": marker}], "stream": False},
    )
    choices = response.get("choices") or []
    if not choices or choices[0].get("message", {}).get("content") != expected_reply:
        raise RuntimeError("Proxy did not return the expected local fake-model response")
    print("Proxy response: passed")

    for _ in range(20):
        layer = panel_action(
            args.panel_url.rstrip("/"), "layer", panel_headers,
            {"block_id": block_id, "layer": "L0", "limit": 100, "offset": 0},
        )
        if has_current_turns(layer["items"], marker, expected_reply, session_id):
            print(f"Panel L0 readback: passed (user and assistant, session={session_id}, marker={marker})")
            return
        time.sleep(1)
    raise RuntimeError("Panel L0 readback missing the new conversation after 20 seconds")


if __name__ == "__main__":
    main()
