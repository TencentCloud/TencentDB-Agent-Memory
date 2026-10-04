# Changelog — @tencentdb-agent-memory/memory-sdk-ts

## Unreleased — 2026-07-31

### Added

- Added `MemoryClient.createAtomic()` and exported request/response types for `POST /v3/atomic/create`.

- **`V3SkillClient#conversationForceArchive(params)`** — wrapper for
  `POST /v3/skill/conversation/force-archive`, the manual archive
  trigger added in `MemoryCore@7ed54292` (2026-07-28). Complements the
  existing `/conversation/add` auto-triggers (tool_call ≥ 10, bytes ≥
  40 KB) by letting callers force an archive regardless of buffer
  size. Brings the SDK to the full 15 `/v3/skill/*` endpoints defined
  by `src/gateway/skill-handlers.ts`.
- Required kwargs: `session_id / user_id / team_id / agent_id`; optional
  `space_id / reason / task_id`. Like `conversationAdd`, this method
  does NOT merge constructor defaults — callers pass ids explicitly.
- Response is `{ status: "empty" | "archived", ... }`. When
  `status === "archived"`, `task_id / archived_at_ms / archive_key` sit
  at the top level (NOT nested under `archived`), which is different
  from `conversationAdd`'s response shape — see the JSDoc.
- New types exported: `SkillConversationForceArchiveRequest`,
  `SkillConversationForceArchiveData`.

## Unreleased — 2026-07-20

### Added

- **`V3SkillClient#conversationAdd(params)`** — wrapper for
  `POST /v3/skill/conversation/add`, the per-turn incremental ingest
  endpoint (see `docs/design/2026-07-15-skill-trigger-in-core-design.md`
  §11.1). This is the 14th `/v3/skill/*` endpoint; earlier releases
  were missing the SDK method. `session_id / user_id / team_id /
  agent_id` are required; `space_id` and `task_id` optional.
  Response is `{ status: "ok" | "archived", archived? }`.
- **`SkillExtractRequest.space_id`** — SDK now surfaces the optional
  `space_id` body override the server has always accepted; caller can
  target an instance other than the transport's `x-tdai-service-id`
  header. Same convention as `conversationAdd`.
- New types exported: `SkillConversationAddRequest`,
  `SkillConversationAddData`, `SkillConversationMessage`,
  `SkillConversationRole`, `SkillConversationArchivedInfo`.

### Changed

- `SkillExtractMessage.timestamp` narrowed from `number | string` to
  `string`; the server schema (`extractMessageSchema.timestamp` uses
  `z.string().datetime()`) only accepts ISO datetime strings, so
  passing a number would have failed at 400 anyway.

## Unreleased — 2026-07-18

### Removed (breaking)

- **`V3SkillClient#extractResult()`** — the underlying
  `POST /v3/skill/extract/result` endpoint has been deleted server-side.
  In the new architecture skill extraction is fire-and-forget: `extract`
  returns `{ ok, task_id, archived_at_ms, archive_key }` after the archive
  is written; the extractor worker then mines skills asynchronously.
  Observe results via `/v3/skill/list` or `/v3/skill/search`.
- Types deleted: `SkillExtractResultRequest`, `SkillExtractResultData`,
  `SkillExtractStatus`, `SkillExtractSyncData`, `SkillExtractAsyncData`,
  `SkillExtractCandidate`.
- `SkillExtractData` is now a single flat interface `{ ok, task_id,
  archived_at_ms, archive_key }` (previously a `sync | async` union).

## 1.1.0 — 2026-07-08

### Added

- **`V3SkillClient`** (`import { V3SkillClient } from '@tencentdb-agent-memory/memory-sdk-ts'`)
  covering all 14 `/v3/skill/*` endpoints 1:1 with `src/gateway/skill-handlers.ts`:
  - CRUD: `create` / `update` / `patch` / `delete` / `get` / `list` / `search` / `versions`
  - Resource files: `writeFiles` / `removeFiles` / `readFile`
  - Prompt-injection: `listing`
  - Extraction: `extract` (sync/async decided by server) / `extractResult`
  (extractResult later removed in 2026-07-18 — see Unreleased above.)
- Full TypeScript request/response type surface (`SkillSummary`, `SkillDetail`,
  `SkillSearchHit`, `SkillListingData`, `SkillFileContent`, ...) re-exported
  from the package root.
- `SkillErrorCode` numeric constants (`VERSION_STALE = 40901`, ...) for
  callers doing conflict recovery.
- Static resource helpers `SkillClient.encodeUtf8(...)` and
  `SkillClient.encodeBase64(...)` — accept `Buffer` / `Uint8Array` /
  `ArrayBuffer` / pre-encoded base64 string.
- `SkillClient#withDefaults({...})` to clone a client with different
  default isolation ids while sharing the underlying transport.

### Changed

- **`TDAMError.details`** — HTTP transport now propagates envelope `data`
  as `details` when `code !== 0`. Skill version conflicts (40901) put
  `current_version` here; expired-version reads (41002) put
  `latest_version`. Existing consumers ignoring the field see no
  behavior change.

### Notes

- No breaking changes. `MemoryClient` / `MetadataClient` / `V3MemoryClient`
  constructors and methods are untouched.
- Skill isolation fields (`teamId` / `agentId` / `userId` / `taskId`) are
  optional at both the SDK and server layers — the schema only enforces
  the "agent_id requires team_id" cross-field rule. Missing IDs surface
  as server-side 40001/40301/40302, not client-side exceptions.
