from __future__ import annotations

import json
import re
from typing import Any


def content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    chunks.append(str(item.get("text") or ""))
                elif "text" in item:
                    chunks.append(str(item.get("text") or ""))
                elif item.get("type") == "image_url":
                    chunks.append("[image]")
                else:
                    chunks.append(json.dumps(json_safe(item), ensure_ascii=False))
            else:
                chunks.append(str(item))
        return "\n".join(part for part in chunks if part)
    if isinstance(content, dict):
        if "text" in content:
            return str(content.get("text") or "")
        if "content" in content:
            return content_to_text(content.get("content"))
        return json.dumps(json_safe(content), ensure_ascii=False)
    return str(content)


def json_safe(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except TypeError:
        pass
    if hasattr(value, "model_dump"):
        return json_safe(value.model_dump())
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    return str(value)


def truncate_text(text: str, max_chars: int, *, marker: str = "[tdai] Text truncated.") -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    suffix = f"\n\n{marker}"
    keep = max(0, max_chars - len(suffix))
    return text[:keep].rstrip() + suffix


def slug(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip())
    return value.strip("-") or "default"


def strip_memory_tool_guide(context: str) -> str:
    if "tdai_memory_search" not in context and "tdai_conversation_search" not in context:
        return context
    lines = []
    for line in context.splitlines():
        if "tdai_memory_search" in line or "tdai_conversation_search" in line:
            continue
        lines.append(line)
    return "\n".join(lines).strip()
