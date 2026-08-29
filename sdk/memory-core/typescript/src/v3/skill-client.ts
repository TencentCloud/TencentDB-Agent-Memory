/**
 * v3 SkillClient — thin wrapper around the 17 `/v3/skill/*` endpoints
 * defined by `src/gateway/skill-handlers.ts`:
 *
 *   create / update / patch / delete / get / get-by-name / list / search
 *   versions / files/write / files/remove / files/read / export / listing
 *   extract / conversation/add / conversation/force-archive
 *
 * Unlike v3 `MemoryClient`, skill isolation fields for the CRUD/file/
 * listing/search endpoints are *all optional* at the schema layer (see
 * `src/gateway/skill-schemas.ts idFieldsShape`). We therefore accept
 * them at construction as *defaults* — every call can override — and
 * never throw client-side on missing ids. The server returns
 * 40001/40301/40302 as needed.
 *
 * The `/extract`, `/conversation/add`, and `/conversation/force-archive`
 * endpoints declare stricter per-field requirements. This SDK merges
 * constructor defaults for `/extract`, then validates required IDs and
 * non-empty messages locally; `/conversation/add` and
 * `/conversation/force-archive` validate their explicit per-call fields
 * locally without merging in defaults.
 */

import { ParamError } from "../errors.js";
import { V3HttpTransport } from "./http.js";
import type { Transport } from "../client.js";
import type {
  SkillClientDefaults,
  SkillConversationAddData,
  SkillConversationAddRequest,
  SkillConversationForceArchiveData,
  SkillConversationForceArchiveRequest,
  SkillCreateRequest,
  SkillDeleteData,
  SkillDeleteRequest,
  SkillDetail,
  SkillExportData,
  SkillExportRequest,
  SkillExtractData,
  SkillExtractRequest,
  SkillFileContent,
  SkillFilesReadRequest,
  SkillFilesRemoveRequest,
  SkillFilesWriteRequest,
  SkillGetByNameRequest,
  SkillGetRequest,
  SkillIdFields,
  SkillListData,
  SkillListRequest,
  SkillListingData,
  SkillListingRequest,
  SkillPatchRequest,
  SkillResourcePayload,
  SkillSearchData,
  SkillSearchRequest,
  SkillSummary,
  SkillUpdateRequest,
  SkillVersionsData,
  SkillVersionsRequest,
} from "./skill-types.js";
import type { MemoryClientConfig } from "../client.js";

const V3 = "/v3/skill";

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function validateRequiredStrings(body: Record<string, unknown>, fields: string[], operation: string): void {
  const missing = fields.filter((field) => typeof body[field] !== "string" || !(body[field] as string).trim());
  if (missing.length) throw new ParamError(`${operation} requires non-empty ${missing.join(", ")}`);
}

function validateMessages(messages: unknown, operation: string): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ParamError(`${operation} requires at least one message`);
  }
}

export interface SkillClientConfig extends MemoryClientConfig, SkillClientDefaults {}

/**
 * SkillClient — construct once per (endpoint, service, defaults) triple.
 *
 * ```ts
 * const skills = new SkillClient({
 *   endpoint: "https://memory.tencentyun.com",
 *   apiKey: "sk-...",
 *   serviceId: "mem-abc",
 *   teamId: "t1",
 *   agentId: "agent-coder",
 *   userId: "u1",
 * });
 * const created = await skills.create({ name: "py-tips", content: "---\nname: py-tips\n..." });
 * ```
 */
export class SkillClient {
  private readonly http: Transport;
  private readonly defaults: Required<Pick<SkillClientDefaults, never>> & SkillClientDefaults;

  constructor(config: SkillClientConfig);
  constructor(transport: Transport, defaults?: SkillClientDefaults);
  constructor(configOrTransport: SkillClientConfig | Transport, defaults?: SkillClientDefaults) {
    if ("post" in configOrTransport) {
      this.http = configOrTransport;
      this.defaults = { ...(defaults ?? {}) };
      return;
    }
    const cfg = configOrTransport;
    this.http = new V3HttpTransport({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey,
      serviceId: cfg.serviceId,
      timeout: cfg.timeout,
      rejectUnauthorized: cfg.rejectUnauthorized,
    });
    this.defaults = {
      teamId: cfg.teamId,
      agentId: cfg.agentId,
      userId: cfg.userId,
      taskId: cfg.taskId,
    };
  }

  /** Return a clone that shares the same transport but with overridden defaults. */
  withDefaults(overrides: SkillClientDefaults): SkillClient {
    return new SkillClient(this.http, { ...this.defaults, ...overrides });
  }

  // ─────────────────────────────────────────────────────────────
  // helpers
  // ─────────────────────────────────────────────────────────────

  /** Merge SDK-level defaults with per-call id overrides. */
  private ids(overrides: SkillIdFields): SkillIdFields {
    return {
      user_id: overrides.user_id ?? this.defaults.userId,
      team_id: overrides.team_id ?? this.defaults.teamId,
      agent_id: overrides.agent_id ?? this.defaults.agentId,
      task_id: overrides.task_id ?? this.defaults.taskId,
    };
  }

  /**
   * Build a utf-8 SkillResourcePayload. Handy when uploading source /
   * markdown / config files without dealing with encoding yourself.
   */
  static encodeUtf8(
    path: string,
    content: string,
    opts: { mime_type?: string; is_executable?: boolean } = {},
  ): SkillResourcePayload {
    return {
      path,
      content,
      encoding: "utf-8",
      mime_type: opts.mime_type,
      is_executable: opts.is_executable,
    };
  }

  /**
   * Build a base64 SkillResourcePayload from binary bytes. Accepts
   * Buffer / Uint8Array / ArrayBuffer / base64 string — everything else
   * is treated as a base64 string as-is.
   */
  static encodeBase64(
    path: string,
    bytes: Buffer | Uint8Array | ArrayBuffer | string,
    opts: { mime_type?: string; is_executable?: boolean } = {},
  ): SkillResourcePayload {
    let content: string;
    if (typeof bytes === "string") {
      content = bytes;
    } else if (bytes instanceof ArrayBuffer) {
      content = Buffer.from(new Uint8Array(bytes)).toString("base64");
    } else if (bytes instanceof Uint8Array) {
      content = Buffer.from(bytes).toString("base64");
    } else {
      // Node Buffer already caught by Uint8Array branch; keep for TS safety.
      content = Buffer.from(bytes as Uint8Array).toString("base64");
    }
    return {
      path,
      content,
      encoding: "base64",
      mime_type: opts.mime_type,
      is_executable: opts.is_executable,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // CRUD
  // ─────────────────────────────────────────────────────────────

  /** `POST /v3/skill/create` — version starts at 1, is_head=true. */
  create(params: SkillCreateRequest): Promise<SkillSummary> {
    const body = stripUndefined({
      ...this.ids(params),
      name: params.name,
      content: params.content,
      resources: params.resources,
      metadata: params.metadata,
    });
    return this.http.post(`${V3}/create`, body);
  }

  /** `POST /v3/skill/update` — full SKILL.md replacement; version+1. */
  update(params: SkillUpdateRequest): Promise<SkillSummary> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      expected_version: params.expected_version,
      content: params.content,
    });
    return this.http.post(`${V3}/update`, body);
  }

  /** `POST /v3/skill/patch` — string replacement; version+1. */
  patch(params: SkillPatchRequest): Promise<SkillSummary> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      expected_version: params.expected_version,
      old_string: params.old_string,
      new_string: params.new_string,
      replace_all: params.replace_all,
    });
    return this.http.post(`${V3}/patch`, body);
  }

  /** `POST /v3/skill/delete` — soft-archive; does not bump version. */
  delete(params: SkillDeleteRequest): Promise<SkillDeleteData> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      expected_version: params.expected_version,
    });
    return this.http.post(`${V3}/delete`, body);
  }

  /** `POST /v3/skill/get` — head or a specific historical version. */
  get(params: SkillGetRequest): Promise<SkillDetail> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      version: params.version,
      include_content: params.include_content,
      include_manifest: params.include_manifest,
    });
    return this.http.post(`${V3}/get`, body);
  }

  /**
   * `POST /v3/skill/get-by-name` — fetch a skill by name in one call.
   *
   * `team_id` and `agent_id` are REQUIRED (schema returns 40001 when
   * missing); unlike the CRUD endpoints, constructor defaults are NOT
   * merged in for these two — pass them explicitly. Returns the same
   * `SkillDetail` shape as `get` (40401 when the name doesn't exist).
   */
  getByName(params: SkillGetByNameRequest): Promise<SkillDetail> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_name: params.skill_name,
      version: params.version,
      include_content: params.include_content,
      include_manifest: params.include_manifest,
    });
    validateRequiredStrings(body, ["team_id", "agent_id"], "getByName");
    return this.http.post(`${V3}/get-by-name`, body);
  }

  /** `POST /v3/skill/list` — head rows for the team, paginated. */
  list(params: SkillListRequest = {}): Promise<SkillListData> {
    const body = stripUndefined({
      ...this.ids(params),
      filters: params.filters,
      pagination: params.pagination,
    });
    return this.http.post(`${V3}/list`, body);
  }

  /** `POST /v3/skill/search` — BM25 / embedding / hybrid over head+active rows. */
  search(params: SkillSearchRequest): Promise<SkillSearchData> {
    const body = stripUndefined({
      ...this.ids(params),
      query: params.query,
      top_k: params.top_k,
      mode: params.mode,
      scope: params.scope,
    });
    return this.http.post(`${V3}/search`, body);
  }

  /** `POST /v3/skill/versions` — all historical versions of a single skill. */
  versions(params: SkillVersionsRequest): Promise<SkillVersionsData> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      pagination: params.pagination,
    });
    return this.http.post(`${V3}/versions`, body);
  }

  // ─────────────────────────────────────────────────────────────
  // resource files
  // ─────────────────────────────────────────────────────────────

  /** `POST /v3/skill/files/write` — batch write; version+1. */
  writeFiles(params: SkillFilesWriteRequest): Promise<SkillSummary> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      expected_version: params.expected_version,
      files: params.files,
    });
    return this.http.post(`${V3}/files/write`, body);
  }

  /** `POST /v3/skill/files/remove` — batch delete; version+1. */
  removeFiles(params: SkillFilesRemoveRequest): Promise<SkillSummary> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      expected_version: params.expected_version,
      paths: params.paths,
    });
    return this.http.post(`${V3}/files/remove`, body);
  }

  /** `POST /v3/skill/files/read` — single resource content. */
  readFile(params: SkillFilesReadRequest): Promise<SkillFileContent> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      version: params.version,
      path: params.path,
      encoding: params.encoding,
    });
    return this.http.post(`${V3}/files/read`, body);
  }

  /** `POST /v3/skill/export` — download the skill (SKILL.md + resources) as a ZIP. */
  exportSkill(params: SkillExportRequest): Promise<SkillExportData> {
    const body = stripUndefined({
      ...this.ids(params),
      skill_id: params.skill_id,
      version: params.version,
      format: params.format,
    });
    return this.http.post(`${V3}/export`, body);
  }

  // ─────────────────────────────────────────────────────────────
  // listing / extract
  // ─────────────────────────────────────────────────────────────

  /** `POST /v3/skill/listing` — render `<available_skills>` block for prompt injection. */
  listing(params: SkillListingRequest = {}): Promise<SkillListingData> {
    const body = stripUndefined({
      ...this.ids(params),
      query: params.query,
      char_budget: params.char_budget,
    });
    return this.http.post(`${V3}/listing`, body);
  }

  /**
   * `POST /v3/skill/extract` — kick off async skill extraction.
   *
   * Returns `{ task_id, archive_key, archived_at_ms }` immediately after
   * the archive is written; the actual skill mining happens in the core
   * worker and is observable via `/v3/skill/list` or `/v3/skill/search`
   * (filter by task_ref_id if you set one on the request). There is no
   * separate poll endpoint — deliberately, see design doc
   * `docs/design/2026-07-17-skill-extract-direct-trigger-plan.md`.
   */
  extract(params: SkillExtractRequest): Promise<SkillExtractData> {
    const body = stripUndefined({
      ...this.ids(params),
      space_id: params.space_id,
      session_id: params.session_id,
      messages: params.messages,
      reason: params.reason,
      options: params.options,
    });
    validateRequiredStrings(body, ["user_id", "team_id", "agent_id"], "extract");
    validateMessages(params.messages, "extract");
    return this.http.post(`${V3}/extract`, body);
  }

  /**
   * `POST /v3/skill/conversation/add` — append the current turn's
   * incremental messages to the session buffer.
   *
   * Unlike the other endpoints, `session_id / user_id / team_id / agent_id`
   * are **required** by `conversationAddRequestSchema`; the SDK does NOT
   * merge in isolation defaults from the constructor (defaults are opt-in
   * per-call — callers pass ids explicitly). `space_id` follows the same
   * convention as `/extract`: optional, falls back to the transport's
   * `x-tdai-service-id` header server-side.
   *
   * Response `status` is `"ok"` for plain buffer-append or `"archived"`
   * when this call tripped a threshold and produced a skill-extract task.
   * See `docs/design/2026-07-15-skill-trigger-in-core-design.md` §11.1.
   */
  conversationAdd(params: SkillConversationAddRequest): Promise<SkillConversationAddData> {
    const body = stripUndefined({
      session_id: params.session_id,
      space_id: params.space_id,
      user_id: params.user_id,
      team_id: params.team_id,
      agent_id: params.agent_id,
      task_id: params.task_id,
      messages: params.messages,
    });
    validateRequiredStrings(body, ["session_id", "user_id", "team_id", "agent_id"], "conversationAdd");
    validateMessages(params.messages, "conversationAdd");
    return this.http.post(`${V3}/conversation/add`, body);
  }

  /**
   * `POST /v3/skill/conversation/force-archive` — manually archive the
   * current session buffer, bypassing the tool_call / bytes thresholds.
   * The third trigger condition alongside `/conversation/add`'s automatic
   * archive triggers (see `docs/design/2026-07-15-skill-trigger-in-core-design.md`).
   *
   * Like `conversationAdd`, isolation fields are REQUIRED and this SDK
   * validates them locally rather than merging constructor defaults.
   * Unlike `conversationAdd`, `space_id` is also REQUIRED here — the
   * schema (`forceArchiveRequestSchema`) declares it non-optional.
   *
   * Returns `{ status: "empty" }` when the buffer has nothing to archive
   * (no messages appended since the last archive), or
   * `{ status: "archived", task_id, archived_at_ms, archive_key }` when
   * the archive was written. Note: unlike `conversation/add`, the
   * archive coordinates live at the top level (not nested under
   * `archived`).
   */
  conversationForceArchive(
    params: SkillConversationForceArchiveRequest,
  ): Promise<SkillConversationForceArchiveData> {
    const body = stripUndefined({
      session_id: params.session_id,
      space_id: params.space_id,
      user_id: params.user_id,
      team_id: params.team_id,
      agent_id: params.agent_id,
      reason: params.reason,
      task_id: params.task_id,
    });
    validateRequiredStrings(
      body,
      ["session_id", "space_id", "user_id", "team_id", "agent_id"],
      "conversationForceArchive",
    );
    return this.http.post(`${V3}/conversation/force-archive`, body);
  }
}
