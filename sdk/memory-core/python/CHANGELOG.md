# Changelog — tencentdb-agent-memory-sdk-python

## Unreleased — 2026-07-31

### Added

- Added `MemoryClient.create_atomic(...)` and `AsyncMemoryClient.create_atomic(...)` for `POST /v3/atomic/create`, with exported `AtomicMemoryType`.

- **`SkillClient.conversation_force_archive(...)`** and
  **`AsyncSkillClient.conversation_force_archive(...)`** — wrapper for
  ``POST /v3/skill/conversation/force-archive``, the manual archive
  trigger added in ``MemoryCore@7ed54292`` (2026-07-28). Complements
  the existing ``/conversation/add`` auto-triggers (tool_call ≥ 10,
  bytes ≥ 40 KB) by letting callers force an archive regardless of
  buffer size. Brings the SDK to the full 15 ``/v3/skill/*`` endpoints
  defined by ``src/gateway/skill-handlers.ts``.
- Required kwargs: ``session_id / user_id / team_id / agent_id``;
  optional ``space_id / reason / task_id``. Like ``conversation_add``,
  this method does NOT merge constructor defaults — callers pass ids
  explicitly.
- Response is ``{"status": "empty" | "archived", ...}``. When
  ``status == "archived"``, ``task_id / archived_at_ms / archive_key``
  sit at the top level (NOT nested under ``archived``), which is
  different from ``conversation_add``'s response shape — see the
  docstring.

## Unreleased — 2026-07-20

### Added

- **`SkillClient.conversation_add(...)`** and
  **`AsyncSkillClient.conversation_add(...)`** — wrapper for
  ``POST /v3/skill/conversation/add``, the per-turn incremental ingest
  endpoint (see ``docs/design/2026-07-15-skill-trigger-in-core-design.md``
  §11.1). This is the 14th ``/v3/skill/*`` endpoint; earlier releases
  were missing the SDK method. ``session_id / user_id / team_id /
  agent_id`` are required kwargs; ``space_id`` and ``task_id`` optional.
  Response is ``{"status": "ok"|"archived", "archived": {...}}``.
- **``space_id`` on ``extract(...)``** — SDK now surfaces the optional
  ``space_id`` body override the server has always accepted; caller can
  target an instance other than the transport's ``x-tdai-service-id``
  header.

## Unreleased — 2026-07-18

### Removed (breaking)

- **`SkillClient.extract_result()`** and **`AsyncSkillClient.extract_result()`**
  — the underlying `POST /v3/skill/extract/result` endpoint has been
  deleted server-side. In the new architecture skill extraction is
  fire-and-forget: `extract` returns `{ok, task_id, archived_at_ms,
  archive_key}` after the archive is written; the extractor worker then
  mines skills asynchronously. Observe results via `/v3/skill/list` or
  `/v3/skill/search`.

## 0.2.0 — 2026-07-08

### Added

- **`SkillClient` / `AsyncSkillClient`** (`from tencentdb_agent_memory.v3
  import SkillClient, AsyncSkillClient`) covering all 14 `/v3/skill/*`
  endpoints 1:1 with `src/gateway/skill-handlers.ts`:
  - CRUD: `create` / `update` / `patch` / `delete` / `get` / `list` / `search` / `versions`
  - Resource files: `write_files` / `remove_files` / `read_file`
  - Prompt-injection: `listing`
  - Extraction: `extract` (sync/async decided by server) / `extract_result`
    (`extract_result` later removed in 2026-07-18 — see Unreleased above.)
- Module-level helpers `encode_utf8(...)` / `encode_base64(...)` for
  building `SkillResourcePayload` dicts.
- `SKILL_ERROR_CODE` numeric constants (`VERSION_STALE = 40901`, ...).
- `SkillClient.with_defaults(...)` clone method for isolated per-call
  scoping while sharing the underlying stub.

### Changed

- **`TDAMError.details`** — HTTP transport now propagates envelope `data`
  as `details` when `code != 0`. Skill version conflicts (40901) put
  `current_version` here; expired-version reads (41002) put
  `latest_version`.

### Notes

- No breaking changes. `MemoryClient` / `AsyncMemoryClient` /
  `MetadataClient` constructors and methods are untouched.
- Skill isolation fields are optional at construction (unlike v3
  `MemoryClient`) — the server schema only enforces
  "agent_id requires team_id".
