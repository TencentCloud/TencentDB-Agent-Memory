"""Bounded, opt-in JSON fence handling; no semantic repair or I/O.

The caller keeps the raw response in its private journal. ``content`` is the
exact original JSON text (including whitespace), not a re-serialization. The
result still needs the caller's schema, evidence and execution-authority checks.
Time and space are O(n), with n bounded by MAX_RAW_BYTES. Container depth is
checked before JSON decoding; nodes include dictionary keys and scalar values.
"""

from dataclasses import dataclass
import hashlib
import json
import math


MAX_RAW_BYTES = 8192
MAX_DEPTH = 16
MAX_NODES = 4096
JSON_WHITESPACE = " \t\r\n"


class ResponseSurfaceRejected(ValueError):
    """A fixed error code, without response text or parser exception details."""


@dataclass(frozen=True)
class JsonObjectSurface:
    content: str
    value: dict
    surface: str
    transformation: str
    raw_sha256: str
    content_sha256: str
    raw_bytes: int
    content_bytes: int

    def audit(self):
        """Text-free metadata. The value/content themselves are private data."""
        return {
            key: getattr(self, key)
            for key in (
                "surface",
                "transformation",
                "raw_sha256",
                "content_sha256",
                "raw_bytes",
                "content_bytes",
            )
        }


def _check_depth(content):
    stack = []
    quoted = escaped = False
    for char in content:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "{[":
            stack.append(char)
            if len(stack) > MAX_DEPTH:
                raise ResponseSurfaceRejected("json_depth")
        elif char in "}]":
            if not stack or stack.pop() != ("{" if char == "}" else "["):
                raise ResponseSurfaceRejected("json_syntax")
    if stack or quoted:
        raise ResponseSurfaceRejected("json_syntax")


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ResponseSurfaceRejected("json_duplicate_key")
        result[key] = value
    return result


def _nonfinite(_value):
    raise ResponseSurfaceRejected("json_nonfinite")


def _check_tree(value):
    pending = [value]
    count = 0
    while pending:
        node = pending.pop()
        count += 1
        if count > MAX_NODES:
            raise ResponseSurfaceRejected("json_nodes")
        if type(node) is dict:
            pending.extend(node.keys())
            pending.extend(node.values())
        elif type(node) is list:
            pending.extend(node)
        elif type(node) is str:
            try:
                node.encode("utf-8")
            except UnicodeError:
                raise ResponseSurfaceRejected("surface_unicode") from None
        elif type(node) is float and not math.isfinite(node):
            raise ResponseSurfaceRejected("json_nonfinite")


def unwrap_json_object(raw, *, allow_json_fence=False):
    """Accept plain JSON, or one exact lowercase json fence when opted in.

    Fence delimiter lines are `````json`` and ````` `` (without the space),
    with LF or CRLF after the opener and before the closer. Only JSON whitespace
    may surround the fence. No prose, substring extraction or repairs occur.
    """
    if type(allow_json_fence) is not bool:
        raise ResponseSurfaceRejected("surface_flag")
    if type(raw) is not str:
        raise ResponseSurfaceRejected("surface_type")
    if len(raw) > MAX_RAW_BYTES:
        raise ResponseSurfaceRejected("surface_capacity")
    try:
        raw_bytes = raw.encode("utf-8")
    except UnicodeError:
        raise ResponseSurfaceRejected("surface_unicode") from None
    if len(raw_bytes) > MAX_RAW_BYTES:
        raise ResponseSurfaceRejected("surface_capacity")

    content = raw
    surface = "plain_json"
    transformation = "none"
    outer = raw.strip(JSON_WHITESPACE)
    if outer.startswith("```"):
        if not allow_json_fence:
            raise ResponseSurfaceRejected("json_fence_disabled")
        opener = next(
            (s for s in ("```json\r\n", "```json\n") if outer.startswith(s)), None
        )
        if opener is None or not outer.endswith("\n```"):
            raise ResponseSurfaceRejected("json_fence_shape")
        content = outer[len(opener) : -3]
        surface = "json_fence"
        transformation = "strip_complete_json_fence"

    _check_depth(content)
    try:
        value = json.loads(content, object_pairs_hook=_pairs, parse_constant=_nonfinite)
    except ResponseSurfaceRejected:
        raise
    except (ValueError, RecursionError):
        raise ResponseSurfaceRejected("json_syntax") from None
    if type(value) is not dict:
        raise ResponseSurfaceRejected("json_object_required")
    _check_tree(value)
    content_bytes = content.encode("utf-8")
    return JsonObjectSurface(
        content=content,
        value=value,
        surface=surface,
        transformation=transformation,
        raw_sha256=hashlib.sha256(raw_bytes).hexdigest(),
        content_sha256=hashlib.sha256(content_bytes).hexdigest(),
        raw_bytes=len(raw_bytes),
        content_bytes=len(content_bytes),
    )
