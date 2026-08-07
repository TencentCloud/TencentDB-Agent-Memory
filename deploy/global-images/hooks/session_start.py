#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CodeBuddy `SessionStart` hook — 把会话 ID 注入到 system prompt，供 MemoryProxy
在客户端不携带会话头（如 4.10.2 ~ 4.10.4）时兜底识别会话。

流程：读 stdin 的 `session_id` → 安全过滤 → 以 `[tdai-proxy-session] conversation_id: <id>`
写入 `additionalContext`；MemoryProxy 端经 `extractConversationIdFromPrompt` 提取，
转发前由 `stripConversationMarker` 剔除。

配置（CodeBuddy settings.json / 项目级配置，指向本脚本绝对路径）:
  "hooks": { "SessionStart": [ { "hooks": [ { "type": "command",
             "command": "python <path>/session_start.py", "timeout": 10 } ] } ] }

仅做会话 ID 注入；stdin 无输入 / 解析失败 / 无 session_id 均放行，不阻断启动。
"""
import json
import sys

# 与 MemoryProxy/src/session/session-key.ts 的 extractConversationIdFromPrompt 保持一致
MARKER_TAG = "[tdai-proxy-session]"


def _safe_session_id(session_id: str) -> str:
    """仅保留安全字符，避免注入异常文本。"""
    return "".join(ch for ch in session_id if ch.isalnum() or ch in "-_.")


def main() -> None:
    # Windows 默认 GBK，强制 UTF-8 以便 CodeBuddy 正确解析 stdout JSON
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"continue": True, "suppressOutput": False}, ensure_ascii=False))
        return

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        print(json.dumps({"continue": True, "suppressOutput": False}, ensure_ascii=False))
        return

    session_id = str(data.get("session_id", "") or "").strip()

    context_parts = []
    if session_id:
        safe_id = _safe_session_id(session_id)
        if safe_id:
            context_parts.append(f"{MARKER_TAG} conversation_id: {safe_id}")

    out = {
        "continue": True,
        "suppressOutput": False,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "permissionDecision": "allow",
        },
    }
    if context_parts:
        out["hookSpecificOutput"]["additionalContext"] = "\n".join(context_parts)

    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
