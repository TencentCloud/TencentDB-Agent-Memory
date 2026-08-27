/**
 * v3 Skill API types — 1:1 with `src/gateway/skill-schemas.ts` and
 * `src/gateway/skill-handlers.ts`.
 *
 * Endpoint reference: docs/skill-v2-api-reference.md.
 *
 * IdFields (all optional at the schema layer, but with the cross-field
 * constraint "agent_id requires team_id"). Write endpoints in practice
 * also need user_id + agent_id, but the SDK does not enforce that —
 * the server returns 40001/40301 if they are missing.
 */

export type SkillIdFields = {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
};

export type SkillStatus = "active" | "archived";

export type SkillResourceEncoding = "utf-8" | "base64";

export interface SkillManifestEntry {
  /** UNIX relative path under `files/`; no `..`, no absolute paths. */
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: SkillResourceEncoding;
  mime_type?: string;
  is_executable?: boolean;
}

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head: boolean;
  status: SkillStatus;
  owner_user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  /** Arbitrary user metadata; present only when the record has non-empty `metadata_json`. */
  metadata?: Record<string, unknown>;
}

export interface SkillDetail extends SkillSummary {
  /** SKILL.md body (frontmatter + content). Present when `include_content !== false`. */
  content?: string;
  /** Present when `include_manifest !== false`. */
  manifest?: SkillManifestEntry[];
  content_hash?: string;
  storage_dir?: string;
}

export interface SkillVersionSummary extends SkillSummary {
  /** True when this version is past the configured retention window (versionTtlSeconds). */
  is_expired: boolean;
}

export interface SkillPagination {
  limit?: number;
  offset?: number;
}

// ── /v3/skill/create ──
export interface SkillCreateRequest extends SkillIdFields {
  /** 1–64 chars; must match the frontmatter `name` inside `content`. */
  name: string;
  /** Full SKILL.md including frontmatter. */
  content: string;
  /** Optional; ≤ 100 entries. Total size ≤ 50 MiB, each ≤ 5 MiB. */
  resources?: SkillResourcePayload[];
  metadata?: Record<string, unknown>;
}

// ── /v3/skill/update ──
export interface SkillUpdateRequest extends SkillIdFields {
  skill_id: string;
  /** Optimistic-lock version; required by the current schema. */
  expected_version: number;
  content: string;
}

// ── /v3/skill/patch ──
export interface SkillPatchRequest extends SkillIdFields {
  skill_id: string;
  expected_version: number;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

// ── /v3/skill/delete ──
export interface SkillDeleteRequest extends SkillIdFields {
  skill_id: string;
  /**
   * Required by the current schema (see `src/gateway/skill-schemas.ts`
   * `deleteRequestSchema`). Guards against archiving a stale head.
   */
  expected_version: number;
}
export interface SkillDeleteData {
  skill_id: string;
  archived: boolean;
}

// ── /v3/skill/get ──
export interface SkillGetRequest extends SkillIdFields {
  skill_id: string;
  version?: number;
  /** Default true. */
  include_content?: boolean;
  /** Default true. */
  include_manifest?: boolean;
}

// ── /v3/skill/get-by-name ──
/**
 * `POST /v3/skill/get-by-name` — locate a skill by `(team_id, agent_id,
 * skill_name)` instead of its internal `skl-xxx` id.
 *
 * Unlike the other CRUD endpoints (which extend the all-optional
 * `SkillIdFields`), `team_id` and `agent_id` are REQUIRED here — the
 * schema (`getByNameRequestSchema`) returns 40001 when either is missing.
 * `skill_name` matches the `<available_skills>` block's `- name:` entry,
 * so agents can fetch a skill's full body in a single call.
 *
 * Returns the same `SkillDetail` shape as `/v3/skill/get` (40401 when no
 * skill with that name exists for the agent).
 */
export interface SkillGetByNameRequest extends SkillIdFields {
  /** Required. */
  team_id: string;
  /** Required. */
  agent_id: string;
  /** Required. 1–64 chars; unique per (team_id, agent_id). */
  skill_name: string;
  version?: number;
  /** Default true. */
  include_content?: boolean;
  /** Default true. */
  include_manifest?: boolean;
}

// ── /v3/skill/list ──
export interface SkillListFilters {
  owner_agent_id?: string;
  name_prefix?: string;
  status?: SkillStatus[];
}
export interface SkillListRequest extends SkillIdFields {
  filters?: SkillListFilters;
  pagination?: SkillPagination;
}
export interface SkillListData {
  items: SkillSummary[];
  total: number;
}

// ── /v3/skill/search ──
export type SkillSearchMode = "bm25" | "embedding" | "hybrid";
export interface SkillSearchRequest extends SkillIdFields {
  query: string;
  top_k?: number;
  mode?: SkillSearchMode;
  /**
   * When `"team"`, the handler strips `agent_id` before searching so
   * the query spans every owner in the team. Otherwise scoped by
   * whatever ids were passed.
   */
  scope?: "team";
}
export interface SkillSearchHit extends SkillSummary {
  score: number;
  /** FTS5 snippet; falls back to `description` when the snippet is empty. */
  snippet: string;
}
export interface SkillSearchData {
  items: SkillSearchHit[];
}

// ── /v3/skill/versions ──
export interface SkillVersionsRequest extends SkillIdFields {
  skill_id: string;
  pagination?: SkillPagination;
}
export interface SkillVersionsData {
  items: SkillVersionSummary[];
  total: number;
}

// ── /v3/skill/files/write ──
export interface SkillFilesWriteRequest extends SkillIdFields {
  skill_id: string;
  expected_version: number;
  /** 1–100 entries. */
  files: SkillResourcePayload[];
}

// ── /v3/skill/files/remove ──
export interface SkillFilesRemoveRequest extends SkillIdFields {
  skill_id: string;
  expected_version: number;
  /** 1–100 UNIX-style paths. */
  paths: string[];
}

// ── /v3/skill/files/read ──
export interface SkillFilesReadRequest extends SkillIdFields {
  skill_id: string;
  version?: number;
  path: string;
  encoding?: SkillResourceEncoding;
}
export interface SkillFileContent {
  path: string;
  content: string;
  encoding: SkillResourceEncoding;
  size_bytes: number;
  mime_type: string;
  version: number;
}

// ── /v3/skill/export ──
export interface SkillExportRequest extends SkillIdFields {
  skill_id: string;
  /** Target version; defaults to head. */
  version?: number;
  /** Only `"zip"` is supported by the schema. */
  format?: "zip";
}
export interface SkillExportData {
  /** ZIP archive bytes, base64-encoded. */
  zip_base64: string;
  /** `${name}.zip`. */
  filename: string;
  name: string;
  version: number;
  file_count: number;
  total_bytes: number;
  warnings: string[];
}

// ── /v3/skill/listing ──
export interface SkillListingRequest extends SkillIdFields {
  query?: string;
  /** 0–64000, default 8000. Enforced server-side. */
  char_budget?: number;
}
export interface SkillListingHit {
  skill_id: string;
  version: number;
  name: string;
}
export interface SkillListingData {
  mode: "full" | "search";
  listing: string;
  hits: SkillListingHit[];
}

// ── /v3/skill/extract ──
export type SkillExtractRole = "user" | "assistant" | "tool_call" | "tool_result" | "system";
export interface SkillExtractMessage {
  role: SkillExtractRole;
  content: string;
  tool_name?: string;
  tool_call_id?: string;
  /**
   * ISO-8601 datetime string. Core schema (`extractMessageSchema.timestamp`
   * in `src/gateway/skill-schemas.ts`) validates via `z.string().datetime()`;
   * passing a number returns 400.
   */
  timestamp?: string;
}
export interface SkillExtractOptions {
  /** 1–64; default 16. */
  max_iterations?: number;
}
export interface SkillExtractRequest extends SkillIdFields {
  /**
   * Required after merging per-call values with SkillClient constructor defaults.
   * SkillClient validates user_id/team_id/agent_id locally before sending.
   */
  /**
   * Instance id. Optional at the schema layer — when omitted, the server
   * falls back to `auth.serviceId` (the `x-tdai-service-id` header). Set
   * this only when the caller intentionally targets a different instance
   * than the one the transport is scoped to; the server logs a mismatch
   * warning and prefers the body value.
   */
  space_id?: string;
  session_id?: string;
  messages: SkillExtractMessage[];
  /** Reason the primary agent decided to trigger extract; injected into the review prompt. */
  reason?: string;
  options?: SkillExtractOptions;
}
/**
 * Direct-trigger returns immediately after the archive is written; the
 * actual skill mining runs in the core worker (async, no separate poll
 * endpoint). Use `/v3/skill/list` or `/v3/skill/search` to observe the
 * resulting skills.
 */
export interface SkillExtractData {
  ok: true;
  task_id: string;
  archived_at_ms: number;
  archive_key: string;
}

// ── /v3/skill/conversation/add ──
/**
 * The 5 message roles accepted by `/v3/skill/conversation/add`
 * (`conversationMessageSchema` in `src/gateway/skill-schemas.ts`).
 * Overlaps with `SkillExtractRole` but kept separate: conversation/add
 * accepts numeric OR string `timestamp` (`z.union([z.number(), z.string()])`),
 * whereas extract only accepts ISO datetime strings.
 */
export type SkillConversationRole = "user" | "assistant" | "tool_call" | "tool_result" | "system";
export interface SkillConversationMessage {
  role: SkillConversationRole;
  content: string;
  /**
   * `tool_call` / `tool_result` messages MUST carry a `tool_call_id` — the
   * handler rejects with 40001 (HandlerValidationError) otherwise. `tool_name`
   * is optional (OpenAI's tool role omits it and skill extraction relies on
   * content, not name).
   */
  tool_name?: string;
  tool_call_id?: string;
  /** Millisecond epoch (number) or ISO datetime (string). */
  timestamp?: number | string;
}

/**
 * `POST /v3/skill/conversation/add` — per-turn incremental ingest. See
 * `docs/design/2026-07-15-skill-trigger-in-core-design.md` §11.1 & §13
 * for the contract.
 *
 * Isolation fields (`session_id / user_id / team_id / agent_id`) are all
 * REQUIRED by `conversationAddRequestSchema` — this SDK type does not
 * reuse `SkillIdFields` (which are all optional). None of them may
 * contain the `|` character (reserved as the Redis queue element
 * separator).
 */
export interface SkillConversationAddRequest {
  session_id: string;
  /**
   * Instance id. Optional at the schema layer — server falls back to
   * `auth.serviceId` (from the `x-tdai-service-id` header). Set only
   * when overriding intentionally; body value wins over header with a
   * mismatch warning logged server-side.
   */
  space_id?: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  /** Business-side task ref id; forwarded to `archive.task.task_ref_id`. Max 128 chars. */
  task_id?: string;
  /** 1–500 messages per call. Bytes are additionally bounded by handler thresholds. */
  messages: SkillConversationMessage[];
}

/**
 * `AddConversationResult` mirror (see
 * `MemoryCore/src/core/skill/conversation-add/add-handler.ts`).
 *
 *   - `status: "ok"` — append-only, no archive yet
 *   - `status: "archived"` — this call tripped one of the archive triggers
 *     and `archived` is populated with the resulting archive coordinates.
 */
export interface SkillConversationArchivedInfo {
  task_id: string;
  archived_at_ms: number;
  archive_key: string;
  /**
   *   - `tool_calls` — tool_call cumulative threshold hit
   *   - `bytes`      — cumulative bytes threshold hit
   *   - `compressed` — this request alone was over the compress threshold
   *   - `oversize`   — even after compression the payload was still oversize
   */
  reason: "tool_calls" | "bytes" | "compressed" | "oversize";
}
export interface SkillConversationAddData {
  status: "ok" | "archived";
  archived?: SkillConversationArchivedInfo;
}

// ── /v3/skill/conversation/force-archive ──
/**
 * `POST /v3/skill/conversation/force-archive` — manually archive the
 * current session buffer, bypassing the tool_call / bytes thresholds.
 * The third trigger condition alongside `/conversation/add`'s automatic
 * thresholds (see `MemoryCore/src/gateway/skill-handlers.ts` +
 * `forceArchiveRequestSchema`).
 *
 * All isolation ids are REQUIRED. Unlike `/extract` and
 * `/conversation/add` (where `space_id` is optional and falls back to
 * `auth.serviceId`), `forceArchiveRequestSchema` makes `space_id` a
 * REQUIRED field — pass it explicitly. Constructor defaults are NOT
 * merged in — callers pass ids explicitly.
 *
 * `reason` (≤ 2000 chars) and `task_id` are optional; `task_id` is
 * forwarded to `archive.task.task_ref_id` when an archive is produced.
 */
export interface SkillConversationForceArchiveRequest {
  session_id: string;
  /** Required by `forceArchiveRequestSchema`. */
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  reason?: string;
  task_id?: string;
}

/**
 * `AddForceArchiveResult` mirror — three shapes:
 *
 *   - `status: "empty"` — buffer had no messages, nothing to archive
 *     (`archived` absent; the server returns a human-readable
 *     `message` alongside).
 *   - `status: "archived"` — archive was written; `task_id`,
 *     `archived_at_ms`, `archive_key` are populated at the top level
 *     (NOT nested under `archived`, unlike `conversation/add`).
 */
export interface SkillConversationForceArchiveData {
  status: "empty" | "archived";
  message?: string;
  task_id?: string;
  archived_at_ms?: number;
  archive_key?: string;
}

// ── SDK-only convenience ──

export interface SkillClientDefaults {
  /** Applied to every request when the caller omits the field. */
  teamId?: string;
  agentId?: string;
  userId?: string;
  taskId?: string;
}

/** Numeric error codes returned in the envelope's `code` field for /v3/skill/*. */
export const SkillErrorCode = {
  BAD_REQUEST: 40001,
  NOT_OWNER: 40301,
  TEAM_MISMATCH: 40302,
  NOT_FOUND: 40401,
  VERSION_STALE: 40901,
  VERSION_EXPIRED: 41002,
  RESOURCE_TOO_LARGE: 41301,
  QUOTA_EXCEEDED: 4291,
  NAME_DUPLICATE: 42201,
  PATCH_NOT_UNIQUE: 42202,
  FRONTMATTER_INVALID: 42203,
  QUEUE_UNAVAILABLE: 50301,
  STORAGE_NOT_FOUND: 50301,
  LLM_UNAVAILABLE: 50302,
  COS_REQUIRED: 50303,
} as const;
export type SkillErrorCodeValue = (typeof SkillErrorCode)[keyof typeof SkillErrorCode];
