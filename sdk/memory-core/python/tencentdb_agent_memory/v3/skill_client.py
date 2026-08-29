"""TencentDB Agent Memory v3 Skill SDK — 17 ``/v3/skill/*`` endpoints:
``create / update / patch / delete / get / get-by-name / list / search
/ versions / files/write / files/remove / files/read / export / listing
/ extract / conversation/add / conversation/force-archive``.

Design & auth
-------------

Mirrors `src/gateway/skill-handlers.ts` 1:1. Unlike :class:`MemoryClient`,
skill isolation fields are generally optional and may be provided as
constructor defaults or per-call overrides. ``extract`` is the exception:
``team_id`` / ``agent_id`` / ``user_id`` are required by the server contract
and are validated locally before a request is sent.

>>> from tencentdb_agent_memory.v3 import SkillClient
>>> skills = SkillClient(
...     endpoint="https://memory.tencentyun.com",
...     api_key="sk-...",
...     service_id="mem-abc",
...     team_id="t1", agent_id="agent-coder", user_id="u1",
... )
>>> created = skills.create(name="py-tips", content="---\\nname: py-tips\\n---\\n# tips\\n")
>>> skills.list()
"""

from __future__ import annotations

import base64
from typing import Any, Dict, Iterable, List, Optional, Union

from .._http import Stub
from .._v3_http import AsyncHttpStub, HttpStub
from ..errors import ParamError

_V3 = "/v3/skill"

# ── Numeric error codes returned in envelope.code for /v3/skill/*. ──
SKILL_ERROR_CODE: Dict[str, int] = {
    "BAD_REQUEST": 40001,
    "NOT_OWNER": 40301,
    "TEAM_MISMATCH": 40302,
    "NOT_FOUND": 40401,
    "VERSION_STALE": 40901,
    "VERSION_EXPIRED": 41002,
    "RESOURCE_TOO_LARGE": 41301,
    "QUOTA_EXCEEDED": 4291,
    "NAME_DUPLICATE": 42201,
    "PATCH_NOT_UNIQUE": 42202,
    "FRONTMATTER_INVALID": 42203,
    "QUEUE_UNAVAILABLE": 50301,
    "STORAGE_NOT_FOUND": 50301,
    "LLM_UNAVAILABLE": 50302,
    "COS_REQUIRED": 50303,
}


def _strip_none(d: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _validate_extract(messages: List[Dict[str, Any]], isolation: Dict[str, Any]) -> None:
    if not isinstance(messages, list) or not messages:
        raise ParamError("extract requires at least one message")
    missing = [
        field for field in ("user_id", "team_id", "agent_id")
        if not isinstance(isolation.get(field), str) or not isolation[field].strip()
    ]
    if missing:
        raise ParamError(f"extract requires non-empty {', '.join(missing)}")


def _validate_force_archive(isolation: Dict[str, Any]) -> None:
    """All five isolation fields (incl. ``space_id``) are required by
    ``forceArchiveRequestSchema``."""
    missing = [
        field for field in ("session_id", "space_id", "user_id", "team_id", "agent_id")
        if not isinstance(isolation.get(field), str) or not isolation[field].strip()
    ]
    if missing:
        raise ParamError(
            f"conversation_force_archive requires non-empty {', '.join(missing)}"
        )


class _SkillDefaults:
    """Container for optional isolation defaults; keyword-mergeable per call."""

    __slots__ = ("team_id", "agent_id", "user_id", "task_id")

    def __init__(
        self,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> None:
        self.team_id = team_id
        self.agent_id = agent_id
        self.user_id = user_id
        self.task_id = task_id

    def merge(
        self,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Merge per-call overrides with defaults; returns a body-ready dict of id fields."""
        return {
            "team_id": team_id if team_id is not None else self.team_id,
            "agent_id": agent_id if agent_id is not None else self.agent_id,
            "user_id": user_id if user_id is not None else self.user_id,
            "task_id": task_id if task_id is not None else self.task_id,
        }


# ---------------------------------------------------------------------------
# Resource-payload helpers (static — no client required)
# ---------------------------------------------------------------------------

def encode_utf8(
    path: str,
    content: str,
    *,
    mime_type: Optional[str] = None,
    is_executable: Optional[bool] = None,
) -> Dict[str, Any]:
    """Build a utf-8 SkillResourcePayload for uploads (create / files/write)."""
    return _strip_none({
        "path": path,
        "content": content,
        "encoding": "utf-8",
        "mime_type": mime_type,
        "is_executable": is_executable,
    })


def encode_base64(
    path: str,
    data: Union[bytes, bytearray, memoryview, str],
    *,
    mime_type: Optional[str] = None,
    is_executable: Optional[bool] = None,
) -> Dict[str, Any]:
    """Build a base64 SkillResourcePayload from raw bytes or a pre-encoded base64 string."""
    if isinstance(data, str):
        encoded = data
    else:
        encoded = base64.b64encode(bytes(data)).decode("ascii")
    return _strip_none({
        "path": path,
        "content": encoded,
        "encoding": "base64",
        "mime_type": mime_type,
        "is_executable": is_executable,
    })


# ---------------------------------------------------------------------------
# Synchronous client
# ---------------------------------------------------------------------------

class SkillClient:
    """Synchronous v3 Skill SDK."""

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            self._stub = HttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)
        self._defaults = _SkillDefaults(team_id, agent_id, user_id, task_id)

    # ── defaults / cloning ─────────────────────────────────────────────

    def with_defaults(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> "SkillClient":
        """Return a clone sharing the transport but with overridden defaults."""
        clone = object.__new__(SkillClient)
        clone._stub = self._stub
        clone._defaults = _SkillDefaults(
            team_id if team_id is not None else self._defaults.team_id,
            agent_id if agent_id is not None else self._defaults.agent_id,
            user_id if user_id is not None else self._defaults.user_id,
            task_id if task_id is not None else self._defaults.task_id,
        )
        return clone

    # Expose helpers as class methods for parity with the TS SDK.
    encode_utf8 = staticmethod(encode_utf8)
    encode_base64 = staticmethod(encode_base64)

    # ── CRUD ───────────────────────────────────────────────────────────

    def create(
        self,
        *,
        name: str,
        content: str,
        resources: Optional[Iterable[Dict[str, Any]]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/create``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "name": name,
            "content": content,
            "resources": list(resources) if resources is not None else None,
            "metadata": metadata,
        })
        return self._stub.post(f"{_V3}/create", body)

    def update(
        self,
        skill_id: str,
        *,
        expected_version: int,
        content: str,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/update``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
            "content": content,
        })
        return self._stub.post(f"{_V3}/update", body)

    def patch(
        self,
        skill_id: str,
        *,
        expected_version: int,
        old_string: str,
        new_string: str,
        replace_all: Optional[bool] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/patch``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
            "old_string": old_string,
            "new_string": new_string,
            "replace_all": replace_all,
        })
        return self._stub.post(f"{_V3}/patch", body)

    def delete(
        self,
        skill_id: str,
        *,
        expected_version: int,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/delete``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
        })
        return self._stub.post(f"{_V3}/delete", body)

    def get(
        self,
        skill_id: str,
        *,
        version: Optional[int] = None,
        include_content: Optional[bool] = None,
        include_manifest: Optional[bool] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/get``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "version": version,
            "include_content": include_content,
            "include_manifest": include_manifest,
        })
        return self._stub.post(f"{_V3}/get", body)

    def get_by_name(
        self,
        skill_name: str,
        *,
        team_id: str,
        agent_id: str,
        version: Optional[int] = None,
        include_content: Optional[bool] = None,
        include_manifest: Optional[bool] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/get-by-name`` — locate a skill by ``(team_id,
        agent_id, skill_name)`` in a single call.

        Unlike the CRUD endpoints, ``team_id`` and ``agent_id`` are
        **required** here (``getByNameRequestSchema`` returns 40001 when
        either is missing), so they are NOT merged in from the
        constructor defaults — pass them explicitly. ``skill_name``
        matches the ``<available_skills>`` block's ``- name:`` entry.

        Returns the same shape as :meth:`get` (40401 when the name
        doesn't exist for the agent).
        """
        body = _strip_none({
            "team_id": team_id,
            "agent_id": agent_id,
            "skill_name": skill_name,
            "version": version,
            "include_content": include_content,
            "include_manifest": include_manifest,
            "user_id": user_id,
            "task_id": task_id,
        })
        missing = [
            field for field in ("team_id", "agent_id", "skill_name")
            if not isinstance(body.get(field), str) or not body[field].strip()
        ]
        if missing:
            raise ParamError(f"get_by_name requires non-empty {', '.join(missing)}")
        return self._stub.post(f"{_V3}/get-by-name", body)

    def list(
        self,
        *,
        filters: Optional[Dict[str, Any]] = None,
        pagination: Optional[Dict[str, Any]] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/list``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "filters": filters,
            "pagination": pagination,
        })
        return self._stub.post(f"{_V3}/list", body)

    def search(
        self,
        query: str,
        *,
        top_k: Optional[int] = None,
        mode: Optional[str] = None,
        scope: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/search`` — ``mode`` ∈ {bm25, embedding, hybrid}; ``scope`` = "team" to drop agent filter."""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "query": query,
            "top_k": top_k,
            "mode": mode,
            "scope": scope,
        })
        return self._stub.post(f"{_V3}/search", body)

    def versions(
        self,
        skill_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/versions``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "pagination": pagination,
        })
        return self._stub.post(f"{_V3}/versions", body)

    # ── resource files ─────────────────────────────────────────────────

    def write_files(
        self,
        skill_id: str,
        *,
        expected_version: int,
        files: Iterable[Dict[str, Any]],
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/files/write``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
            "files": list(files),
        })
        return self._stub.post(f"{_V3}/files/write", body)

    def remove_files(
        self,
        skill_id: str,
        *,
        expected_version: int,
        paths: Iterable[str],
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/files/remove``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
            "paths": list(paths),
        })
        return self._stub.post(f"{_V3}/files/remove", body)

    def read_file(
        self,
        skill_id: str,
        path: str,
        *,
        version: Optional[int] = None,
        encoding: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/files/read``"""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "version": version,
            "path": path,
            "encoding": encoding,
        })
        return self._stub.post(f"{_V3}/files/read", body)

    def export_skill(
        self,
        skill_id: str,
        *,
        version: Optional[int] = None,
        format: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/export`` — download the skill (SKILL.md +
        resources) as a ZIP.

        Returns ``{zip_base64, filename, name, version, file_count,
        total_bytes, warnings}``. Decode ``zip_base64`` (base64) into the
        archive bytes yourself. ``format`` defaults to ``"zip"`` (the
        only value the schema accepts).
        """
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "version": version,
            "format": format,
        })
        return self._stub.post(f"{_V3}/export", body)

    # ── listing / extract ─────────────────────────────────────────────

    def listing(
        self,
        *,
        query: Optional[str] = None,
        char_budget: Optional[int] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/listing`` — render ``<available_skills>`` block."""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "query": query,
            "char_budget": char_budget,
        })
        return self._stub.post(f"{_V3}/listing", body)

    def extract(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
        reason: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
        space_id: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/extract`` — fire-and-forget async extract.

        Returns ``{ok, task_id, archived_at_ms, archive_key}`` immediately
        after the archive is written; the core worker mines skills
        asynchronously. There is no separate poll endpoint — observe
        results via ``list``/``search`` (filter by ``task_ref_id`` if you
        set one on the request).

        ``space_id`` is optional at the schema layer: when omitted the
        server falls back to the transport's ``x-tdai-service-id``
        header (``auth.serviceId``). Set only when explicitly overriding
        the instance the transport is scoped to; body value wins over
        header, and a mismatch is logged server-side.
        """
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "space_id": space_id,
            "session_id": session_id,
            "messages": messages,
            "reason": reason,
            "options": options,
        })
        _validate_extract(messages, body)
        return self._stub.post(f"{_V3}/extract", body)

    def conversation_add(
        self,
        *,
        session_id: str,
        user_id: str,
        team_id: str,
        agent_id: str,
        messages: List[Dict[str, Any]],
        space_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/conversation/add`` — append this turn's messages
        to the session buffer.

        Unlike the CRUD endpoints, ``session_id / user_id / team_id /
        agent_id`` are **required** by ``conversationAddRequestSchema``,
        so this method does NOT merge in the constructor-time defaults —
        callers must pass isolation ids explicitly. Any ``|`` character
        in an id is rejected server-side (Redis queue separator).

        ``space_id`` follows the same convention as :meth:`extract`:
        optional, server falls back to ``auth.serviceId``. ``task_id``
        is forwarded to ``archive.task.task_ref_id`` when this call
        happens to trip an archive threshold.

        Returns ``{status: "ok"|"archived", archived?: {task_id,
        archived_at_ms, archive_key, reason}}``. ``reason`` ∈
        ``{tool_calls, bytes, compressed, oversize}``. See
        ``docs/design/2026-07-15-skill-trigger-in-core-design.md`` §11.1
        for the trigger semantics.
        """
        body = _strip_none({
            "session_id": session_id,
            "space_id": space_id,
            "user_id": user_id,
            "team_id": team_id,
            "agent_id": agent_id,
            "task_id": task_id,
            "messages": messages,
        })
        return self._stub.post(f"{_V3}/conversation/add", body)

    def conversation_force_archive(
        self,
        *,
        session_id: str,
        user_id: str,
        team_id: str,
        agent_id: str,
        space_id: str,
        reason: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/conversation/force-archive`` — manually archive
        the current session buffer, bypassing the tool_call / bytes
        thresholds. The third trigger condition alongside
        :meth:`conversation_add`'s automatic archive triggers (see
        ``docs/design/2026-07-15-skill-trigger-in-core-design.md``).

        Like :meth:`conversation_add`, ``session_id / user_id / team_id /
        agent_id`` are **required** kwargs, and this method does NOT
        merge in constructor defaults. Unlike :meth:`conversation_add`
        and :meth:`extract`, ``space_id`` is also **required** here —
        ``forceArchiveRequestSchema`` declares it non-optional, so pass
        it explicitly. ``reason`` (≤ 2000 chars) is embedded in the
        resulting archive; ``task_id`` is forwarded to
        ``archive.task.task_ref_id``.

        Returns one of two shapes:

        - ``{"status": "empty", "message": "..."}`` — buffer had no
          messages, nothing to archive.
        - ``{"status": "archived", "task_id": ..., "archived_at_ms":
          ..., "archive_key": "..."}`` — archive was written. Note the
          coordinates are at the top level (not nested under
          ``archived``), unlike :meth:`conversation_add`.
        """
        body = _strip_none({
            "session_id": session_id,
            "space_id": space_id,
            "user_id": user_id,
            "team_id": team_id,
            "agent_id": agent_id,
            "reason": reason,
            "task_id": task_id,
        })
        _validate_force_archive(body)
        return self._stub.post(f"{_V3}/conversation/force-archive", body)

    # ── lifecycle ─────────────────────────────────────────────────────

    def close(self) -> None:
        self._stub.close()

    def __enter__(self) -> "SkillClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Asynchronous client
# ---------------------------------------------------------------------------

class AsyncSkillClient:
    """Asynchronous v3 Skill SDK. Method signatures match :class:`SkillClient`."""

    def __init__(
        self,
        endpoint: str = "",
        api_key: str = "",
        service_id: Optional[str] = None,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
        timeout: float = 30,
        verify: bool = True,
        stub: Optional[Stub] = None,
    ) -> None:
        if stub is not None:
            self._stub = stub
        else:
            if not service_id:
                raise ParamError("service_id must be provided")
            self._stub = AsyncHttpStub(endpoint, api_key, service_id, timeout=timeout, verify=verify)
        self._defaults = _SkillDefaults(team_id, agent_id, user_id, task_id)

    def with_defaults(
        self,
        *,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> "AsyncSkillClient":
        clone = object.__new__(AsyncSkillClient)
        clone._stub = self._stub
        clone._defaults = _SkillDefaults(
            team_id if team_id is not None else self._defaults.team_id,
            agent_id if agent_id is not None else self._defaults.agent_id,
            user_id if user_id is not None else self._defaults.user_id,
            task_id if task_id is not None else self._defaults.task_id,
        )
        return clone

    encode_utf8 = staticmethod(encode_utf8)
    encode_base64 = staticmethod(encode_base64)

    # ── CRUD ───────────────────────────────────────────────────────────

    async def create(
        self,
        *,
        name: str,
        content: str,
        resources: Optional[Iterable[Dict[str, Any]]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "name": name,
            "content": content,
            "resources": list(resources) if resources is not None else None,
            "metadata": metadata,
        })
        return await self._stub.post(f"{_V3}/create", body)

    async def update(
        self,
        skill_id: str,
        *,
        expected_version: int,
        content: str,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
            "content": content,
        })
        return await self._stub.post(f"{_V3}/update", body)

    async def patch(
        self,
        skill_id: str,
        *,
        expected_version: int,
        old_string: str,
        new_string: str,
        replace_all: Optional[bool] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
            "old_string": old_string,
            "new_string": new_string,
            "replace_all": replace_all,
        })
        return await self._stub.post(f"{_V3}/patch", body)

    async def delete(
        self,
        skill_id: str,
        *,
        expected_version: int,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
        })
        return await self._stub.post(f"{_V3}/delete", body)

    async def get(
        self,
        skill_id: str,
        *,
        version: Optional[int] = None,
        include_content: Optional[bool] = None,
        include_manifest: Optional[bool] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "version": version,
            "include_content": include_content,
            "include_manifest": include_manifest,
        })
        return await self._stub.post(f"{_V3}/get", body)

    async def get_by_name(
        self,
        skill_name: str,
        *,
        team_id: str,
        agent_id: str,
        version: Optional[int] = None,
        include_content: Optional[bool] = None,
        include_manifest: Optional[bool] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """``POST /v3/skill/get-by-name`` — locate a skill by ``(team_id,
        agent_id, skill_name)`` in a single call.

        ``team_id`` and ``agent_id`` are **required** here (schema
        returns 40001 when missing), so they are NOT merged in from the
        constructor defaults — pass them explicitly. Returns the same
        shape as :meth:`get`.
        """
        body = _strip_none({
            "team_id": team_id,
            "agent_id": agent_id,
            "skill_name": skill_name,
            "version": version,
            "include_content": include_content,
            "include_manifest": include_manifest,
            "user_id": user_id,
            "task_id": task_id,
        })
        missing = [
            field for field in ("team_id", "agent_id", "skill_name")
            if not isinstance(body.get(field), str) or not body[field].strip()
        ]
        if missing:
            raise ParamError(f"get_by_name requires non-empty {', '.join(missing)}")
        return await self._stub.post(f"{_V3}/get-by-name", body)

    async def list(
        self,
        *,
        filters: Optional[Dict[str, Any]] = None,
        pagination: Optional[Dict[str, Any]] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "filters": filters,
            "pagination": pagination,
        })
        return await self._stub.post(f"{_V3}/list", body)

    async def search(
        self,
        query: str,
        *,
        top_k: Optional[int] = None,
        mode: Optional[str] = None,
        scope: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "query": query,
            "top_k": top_k,
            "mode": mode,
            "scope": scope,
        })
        return await self._stub.post(f"{_V3}/search", body)

    async def versions(
        self,
        skill_id: str,
        *,
        pagination: Optional[Dict[str, Any]] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "pagination": pagination,
        })
        return await self._stub.post(f"{_V3}/versions", body)

    # ── resource files ─────────────────────────────────────────────────

    async def write_files(
        self,
        skill_id: str,
        *,
        expected_version: int,
        files: Iterable[Dict[str, Any]],
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
            "files": list(files),
        })
        return await self._stub.post(f"{_V3}/files/write", body)

    async def remove_files(
        self,
        skill_id: str,
        *,
        expected_version: int,
        paths: Iterable[str],
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "expected_version": expected_version,
            "paths": list(paths),
        })
        return await self._stub.post(f"{_V3}/files/remove", body)

    async def read_file(
        self,
        skill_id: str,
        path: str,
        *,
        version: Optional[int] = None,
        encoding: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "version": version,
            "path": path,
            "encoding": encoding,
        })
        return await self._stub.post(f"{_V3}/files/read", body)

    async def export_skill(
        self,
        skill_id: str,
        *,
        version: Optional[int] = None,
        format: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """See :meth:`SkillClient.export_skill` for the contract."""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "skill_id": skill_id,
            "version": version,
            "format": format,
        })
        return await self._stub.post(f"{_V3}/export", body)

    # ── listing / extract ─────────────────────────────────────────────

    async def listing(
        self,
        *,
        query: Optional[str] = None,
        char_budget: Optional[int] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "query": query,
            "char_budget": char_budget,
        })
        return await self._stub.post(f"{_V3}/listing", body)

    async def extract(
        self,
        messages: List[Dict[str, Any]],
        *,
        session_id: Optional[str] = None,
        reason: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
        space_id: Optional[str] = None,
        team_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        user_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """See :meth:`SkillClient.extract` for parameter and response docs."""
        body = _strip_none({
            **self._defaults.merge(team_id, agent_id, user_id, task_id),
            "space_id": space_id,
            "session_id": session_id,
            "messages": messages,
            "reason": reason,
            "options": options,
        })
        _validate_extract(messages, body)
        return await self._stub.post(f"{_V3}/extract", body)

    async def conversation_add(
        self,
        *,
        session_id: str,
        user_id: str,
        team_id: str,
        agent_id: str,
        messages: List[Dict[str, Any]],
        space_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """See :meth:`SkillClient.conversation_add` for the contract."""
        body = _strip_none({
            "session_id": session_id,
            "space_id": space_id,
            "user_id": user_id,
            "team_id": team_id,
            "agent_id": agent_id,
            "task_id": task_id,
            "messages": messages,
        })
        return await self._stub.post(f"{_V3}/conversation/add", body)

    async def conversation_force_archive(
        self,
        *,
        session_id: str,
        user_id: str,
        team_id: str,
        agent_id: str,
        space_id: str,
        reason: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """See :meth:`SkillClient.conversation_force_archive` for the contract."""
        body = _strip_none({
            "session_id": session_id,
            "space_id": space_id,
            "user_id": user_id,
            "team_id": team_id,
            "agent_id": agent_id,
            "reason": reason,
            "task_id": task_id,
        })
        _validate_force_archive(body)
        return await self._stub.post(f"{_V3}/conversation/force-archive", body)

    # ── lifecycle ─────────────────────────────────────────────────────

    async def close(self) -> None:
        await self._stub.close()

    async def __aenter__(self) -> "AsyncSkillClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
