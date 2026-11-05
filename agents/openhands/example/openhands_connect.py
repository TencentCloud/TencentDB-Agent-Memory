#!/usr/bin/env python3
"""Minimal OpenHands -> TencentDB-Agent-Memory proxy connection example.

Two rules this file exists to make obvious:

1. All four identity headers must be present on the FIRST turn of a session.
   Header preselect only runs inside the "session not yet initialised" branch
   (MemoryProxy/src/session/codebuddy/init.ts:824-825). If the first turn misses
   one header the session parks at pending_asset_confirm (init.ts:1000) and the
   recovery branch (init.ts:1099) never re-resolves the preset identity -> that
   session stays uninjected no matter how correct the later turns are.
2. agentSource comes from the first URL path segment
   (MemoryProxy/src/handler.ts:665-667), so use /openhands/<spaceId>/v1 --
   borrowing /codebuddy/ silently mislabels every session and credit record.

Usage:
  python3 openhands_connect.py --check      # probes only, no OpenHands install needed
  TDAM_PROXY_BASE_URL=http://<host>:8096/openhands/<spaceId> TDAM_USER_KEY=sk-mem-... \
      python3 openhands_connect.py

No network is touched at import time.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# Headers the proxy's header-preselect path reads: defaults at
# MemoryProxy/src/config.ts:98-104, wired :426-431; the generated config writes
# headerAutoSelect.enabled: true (deploy/global-images/start-proxy.sh:129-134).
TEAM_HEADER = "x-team-id"
AGENT_HEADER = "x-agent-id"
TASK_HEADER = "x-task-id"
CONV_HEADER = "x-conversation-id"

# skill-bridge.ts:234-242 resolves the session id from these (in order);
# :503-506 takes spaceId from x-tdai-service-id and the gate at :516-519 SKIPS the
# persisted (L2b) lookup entirely when it is empty, so the call 40101s at :526.
SERVICE_ID_HEADER = "x-tdai-service-id"


class ProxyConfig:
    """Everything comes from env; constructing it performs no I/O."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("TDAM_PROXY_BASE_URL", "").rstrip("/")
        self.user_key = os.environ.get("TDAM_USER_KEY", "")
        self.model = os.environ.get("TDAM_MODEL", "openai/<model-id>")
        self.space_id = os.environ.get("TDAM_SPACE_ID", "default")
        self.team_id = os.environ.get("TDAM_TEAM_ID", "")
        self.agent_id = os.environ.get("TDAM_AGENT_ID", "")
        self.task_id = os.environ.get("TDAM_TASK_ID", "")

    @property
    def origin(self) -> str:
        """Scheme+host+port, for endpoints that live outside /<agent>/<spaceId>."""
        idx = self.base_url.find("://")
        if idx == -1:
            return self.base_url
        slash = self.base_url.find("/", idx + 3)
        return self.base_url if slash == -1 else self.base_url[:slash]

    def identity_headers(self, conversation_id: str) -> dict:
        """The 4 preselect headers + Authorization + the bridge space header."""
        return {
            "Authorization": "Bearer " + self.user_key,
            TEAM_HEADER: self.team_id,
            AGENT_HEADER: self.agent_id,
            TASK_HEADER: self.task_id,
            CONV_HEADER: conversation_id,
            SERVICE_ID_HEADER: self.space_id,
        }

    def missing_required(self, conversation_id: str) -> list:
        """Fields the proxy needs to register a session. Empty list == safe to start."""
        gaps = [name for name, value in (
            (TEAM_HEADER, self.team_id),
            (AGENT_HEADER, self.agent_id),
            (TASK_HEADER, self.task_id),
            (CONV_HEADER, conversation_id),
            ("TDAM_USER_KEY", self.user_key),
            ("TDAM_PROXY_BASE_URL", self.base_url),
        ) if not value]
        if self.base_url and "/openhands/" not in self.base_url:
            gaps.append("base_url must route through /openhands/<spaceId> (got %s)"
                        % self.base_url)
        if "/codebuddy/" in self.base_url:
            gaps.append("base_url borrows /codebuddy/ -> agentSource mislabel")
        return gaps


def make_session_id(prefix: str) -> str:
    """Conversation-id discipline helper -- the bridging trick, with its trade-off.

    The chat handler stores sessions under the composite key
    ``${agentSource}:${sessionId}`` (handler.ts:810, :877), while skill-bridge L1
    probes a bare id plus hard-coded prefixes (skill-bridge.ts:294-297). So a bare
    id only resolves if its prefix happens to be probed. Pre-pending a prefix that
    IS probed makes the session visible to bridge callers in the current tree.

    'hermes:' is chosen because hermes shares the identical wire shape (OpenAI
    chat + header preselect) and is already probed. Beware: agent_source is
    recovered by splitting the matched key (skill-bridge.ts:251-254), so the
    prefix is what gets recorded as the session's agent source. Prefer a bare id
    plus the correct 'openhands:' prefix once this PR's skill-bridge commit ships;
    the persisted binding path never cared about prefixes -- bindings key on
    (spaceId, sessionId) with a BARE sessionId and no agentSource
    (MemoryProxy/src/db/binding-repo.ts:43-48, :54-57; written at
    MemoryProxy/src/session/store.ts:244).
    """
    return "hermes:" + prefix


# Backwards-compatible alias used in earlier drafts of this example.
make_conversation_id = make_session_id


def _get_json(cfg: ProxyConfig, path: str, headers=None):
    """(status, payload) with the key never echoed back in the payload."""
    request = urllib.request.Request(cfg.origin + path, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            text = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # refused / DNS / timeout -- reported, never raised
        return 0, "%s: %s" % (type(exc).__name__, exc)
    try:
        return 200, json.loads(text)
    except json.JSONDecodeError:
        return 200, text


def self_check(cfg: ProxyConfig) -> int:
    """Probe the proxy's own endpoints. Never sends a completion request.

    GET /health -> MemoryProxy/src/server.ts:85-105 (status + storage backend).
    GET /whoami -> MemoryProxy/src/server.ts:108 (key -> key id, plain text).
    """
    status, payload = _get_json(cfg, "/health")
    if status == 200 and isinstance(payload, dict):
        storage = payload.get("storage") or {}
        print("[ok] /health status=%s storage=%s degraded=%s"
              % (payload.get("status"), storage.get("effective"),
                 storage.get("degraded")))
    else:
        print("[fail] /health http=%s payload=%r" % (status, payload))
        print("       proxy unreachable -- check TDAM_PROXY_BASE_URL")
        return 1

    if not cfg.user_key:
        print("[skip] /whoami: set TDAM_USER_KEY to validate your sk-mem-<user_key>")
        return 0
    status, payload = _get_json(
        cfg, "/whoami", {"Authorization": "Bearer " + cfg.user_key})
    # Mask before printing: never echo a credential-shaped substring of the key.
    shown = str(payload).replace(cfg.user_key, "sk-mem-****")
    print("[%s] /whoami http=%s %s" % ("ok" if status == 200 else "fail",
                                       status, shown))
    return 0 if status == 200 else 1


def build_llm(cfg: ProxyConfig, conversation_id: str):
    """Construct the OpenHands SDK LLM pointed at the proxy.

    Importing openhands here (not at module top) keeps --check runnable without the
    SDK. ``extra_headers`` is set once on the LLM object, so LiteLLM attaches it to
    every request the SDK issues -- including internal summarizer / condenser calls.
    That single setting is what keeps the first-turn rule satisfied.
    """
    gaps = cfg.missing_required(conversation_id)
    if gaps:
        raise SystemExit("refusing to start a session that would park:\n  - "
                         + "\n  - ".join(gaps))
    from openhands.sdk import LLM
    return LLM(
        model=cfg.model,
        base_url=cfg.base_url + "/v1",
        api_key=cfg.user_key,
        extra_headers={
            TEAM_HEADER: cfg.team_id,
            AGENT_HEADER: cfg.agent_id,
            TASK_HEADER: cfg.task_id,
            CONV_HEADER: conversation_id,
        },
    )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="OpenHands -> TencentDB-Agent-Memory proxy example")
    parser.add_argument("--check", action="store_true",
                        help="probe /health and /whoami only; no LLM call, no SDK")
    parser.add_argument("--print-headers", action="store_true",
                        help="show the exact header set a turn will carry (key masked)")
    args = parser.parse_args(argv)

    cfg = ProxyConfig()
    if not cfg.base_url:
        print("set TDAM_PROXY_BASE_URL=http://<proxy-host>:8096/openhands/<spaceId>",
              file=sys.stderr)
        return 2

    conversation_id = make_conversation_id(
        os.environ.get("TDAM_CONVERSATION_ID", "demo-%d" % os.getpid()))
    print("x-conversation-id: %s" % conversation_id)

    if args.print_headers:
        for name, value in sorted(cfg.identity_headers(conversation_id).items()):
            if name == "Authorization":
                value = "Bearer sk-mem-****" if cfg.user_key else "Bearer <missing>"
            print("  %s: %s" % (name, value or "<missing>"))
        gaps = cfg.missing_required(conversation_id)
        for gap in gaps:
            print("  WARN %s" % gap)
        return 0 if not gaps else 1

    if self_check(cfg) != 0:
        return 1
    if args.check:
        return 0

    try:
        llm = build_llm(cfg, conversation_id)
    except ImportError:
        print("[skip] openhands-sdk not installed -- identity probes above are the "
              "part this adapter controls.")
        return 0

    # Stopped at construction on purpose: the SDK's conversation/agent surface is
    # versioned upstream (validated against v1.x). UNVERIFIED: exact SDK matrix.
    print("[ok] LLM constructed: model=%s base_url=%s" % (llm.model, llm.base_url))
    print("     every turn carries the 4 identity headers via extra_headers")
    print("     rotate x-conversation-id per conversation; reuse resumes the old session")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
