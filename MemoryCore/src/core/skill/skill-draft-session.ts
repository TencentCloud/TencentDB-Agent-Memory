import { parseDocument } from "yaml";
import type { IdFields, Skill } from "./types.js";
import type { SkillResourcePayload } from "./skill-resource-store.js";
import type { SkillDraftBatch, SkillCandidateSubmission } from "./skill-restructure-types.js";
import { assertResourcePath, assertResourcePaths, assertUnicode, canonical, hash, isTextResource, MAX_PACKAGE_BYTES, MAX_RESOURCE_BYTES, resourceBytes } from "./restructure/snapshot.js";

/** Deliberately excludes all Core mutation methods. */
export interface SkillDraftReadCore {
  get(input: IdFields & { skill_id: string; version?: number; include_content?: boolean; include_manifest?: boolean }): Promise<Skill>;
  list(input: IdFields & { pagination?: { limit?: number; offset?: number } }): Promise<{ items: Skill[]; total: number }>;
  search(input: IdFields & { query: string; top_k?: number }): Promise<Array<{ skill: Skill; score: number }>>;
  readFile(input: IdFields & { skill_id: string; version?: number; path: string; encoding?: "utf-8" | "base64" }): Promise<{ path: string; content: string; encoding: "utf-8" | "base64"; size_bytes: number; mime_type: string; version: number }>;
}
export interface SkillDraftSessionOptions {
  core: SkillDraftReadCore;
  request_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  task_id?: string;
}
export class SkillDraftError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "SkillDraftError"; }
}
export const SKILL_DRAFT_PROTOCOL = `## Active tool protocol: private extraction drafts
All write tools only edit private drafts. They never create/update a live skill or return a published version. skill_list reads the visible library; it does not select the entire library for restructuring.
skill_view(skill_id, version?, offset?, length?) opens a fixed base version and returns draft_id, draft_revision, base_version, read_only, a bounded body page, and a paged manifest. Continue with skill_view(draft_id, offset=next_offset) until needed content is fully read. Never silently switch to a newer live version.
skill_create(name, content, metadata?) creates a private draft and returns draft_id/draft_revision, NOT skill_id/version. skill_update, skill_patch, and skill_files_write require draft_id plus expected_revision. Each successful edit increments draft_revision; use that revision on the next edit. Re-read the draft after a revision conflict. Do not use expected_version for these tools.
Before overwriting an existing body, read ALL its pages. Before overwriting a resource, read ALL its bytes with skill_files_read(draft_id, path, offset?, length?, encoding?). Resource reads stay bound to the fixed base_version; untouched resources and their MIME/executable attributes and user metadata are preserved automatically. Never execute scripts. Draft IDs are private handles and MUST NOT appear in final bodies, resources, or metadata.
Protected, pinned, externally managed, archived and non-owner sources remain readable for context, but are read_only and cannot be changed or published from this session. Do not evade protection by copying them into another draft. A protected read is not an authorization failure.
Large bodies may be staged without premature publication. Package size triggers independent semantic diagnosis and rule extraction after this session: distill reusable rules, preserve safety and exceptions, consolidate related branches, and separate only genuinely independent capabilities. This is NOT mechanical chapter relocation or head/tail truncation. A viewed, unchanged owned source remains eligible for this diagnosis; you need not invent new facts or gratuitously rewrite it.
Your final line describes drafts prepared, not successful publication. Only the publisher's later operation receipts establish saved changes. A tool error is an error, never evidence of a successful save. Correct recoverable tool errors; never discard unread rules or resources to force a write.`;

const MAX_DRAFT_BODY_BYTES = 4_000_000;
const MAX_BATCH_BYTES = 100_000_000;
const MAX_DRAFTS = 32;
type Coverage = Array<[number, number]>;
interface ResourceDraft { payload: SkillResourcePayload; bytes: Buffer; read: Coverage; authored?: boolean }
interface Draft {
  id: string; revision: number; name: string; content: string; body: Buffer; read: Coverage;
  source?: Skill; metadata: Record<string, unknown>; readOnly?: string;
  resources: Map<string, ResourceDraft>; loading: Map<string, Promise<ResourceDraft>>;
}
function covered(read: Coverage, size: number): boolean {
  let end = 0;
  for (const [start, stop] of [...read].sort((a, b) => a[0] - b[0])) {
    if (start > end) return false;
    end = Math.max(end, stop);
    if (end >= size) return true;
  }
  return size === 0;
}
function frontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new SkillDraftError("DRAFT_INVALID_CONTENT", "SKILL.md requires YAML name and description frontmatter");
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) throw new SkillDraftError("DRAFT_INVALID_CONTENT", "Invalid YAML frontmatter");
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SkillDraftError("DRAFT_INVALID_CONTENT", "Frontmatter must be an object");
  return value as Record<string, unknown>;
}
function contentBytes(name: string, content: string): Buffer {
  assertUnicode(content);
  const bytes = Buffer.from(content);
  if (bytes.length > MAX_DRAFT_BODY_BYTES) throw new SkillDraftError("DRAFT_TOO_LARGE", "Private body exceeds the bounded 4MB draft limit");
  const fm = frontmatter(content);
  if (fm.name !== name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || typeof fm.description !== "string" || !fm.description.trim() || fm.description.length > 1024) throw new SkillDraftError("DRAFT_INVALID_CONTENT", "Valid name/description required; the original name cannot change");
  return bytes;
}
function isProtected(content: string, metadata: Record<string, unknown>): boolean {
  const guarded = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const flags = value as Record<string, unknown>;
    return flags.protected === true || flags.pinned === true || flags.external_managed === true || flags.managed_by === "external" || flags.source === "external" || flags.source === "external-managed";
  };
  const fm = frontmatter(content);
  return guarded(metadata) || guarded(metadata.source) || guarded(fm) || guarded(fm.metadata) || guarded(fm.source);
}
function page(bytes: Buffer, offset = 0, length = 8192, utf8 = true) {
  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length || !Number.isInteger(length) || length < 4 || length > 16_384) throw new SkillDraftError("DRAFT_INVALID_PAGE", "Use a byte offset and length between 4 and 16384");
  if (utf8 && offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new SkillDraftError("DRAFT_INVALID_PAGE", "Offset splits a UTF-8 code point; use next_offset");
  let end = Math.min(offset + length, bytes.length);
  if (utf8) while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { bytes: bytes.subarray(offset, end), offset, end, next_offset: end < bytes.length ? end : null, size_bytes: bytes.length };
}

export class SkillDraftSession {
  private readonly drafts = new Map<string, Draft>();
  private readonly opened = new Map<string, Promise<Draft>>();
  private closed = false;
  private sequence = 0;
  private reserved = 0;
  private readonly readIds: IdFields;
  constructor(private readonly options: SkillDraftSessionOptions) {
    this.readIds = { user_id: options.user_id, team_id: options.team_id, agent_id: options.agent_id };
  }
  discard(): void { this.closed = true; }
  private assertOpen() { if (this.closed) throw new SkillDraftError("DRAFT_SESSION_CLOSED", "The private drafting session has ended"); }
  private get(id: string): Draft {
    this.assertOpen(); const draft = this.drafts.get(id);
    if (!draft) throw new SkillDraftError("DRAFT_NOT_FOUND", "Use a draft_id returned by skill_view or skill_create");
    return draft;
  }
  private writable(id: string, revision: number): Draft {
    const draft = this.get(id);
    if (draft.readOnly) throw new SkillDraftError("DRAFT_READ_ONLY", `Source is readable but cannot be changed: ${draft.readOnly}`);
    if (revision !== draft.revision) throw new SkillDraftError("DRAFT_REVISION_CONFLICT", `Current draft_revision is ${draft.revision}; re-read this draft`);
    return draft;
  }
  private receipt(draft: Draft) { return { ok: true, draft_id: draft.id, draft_revision: draft.revision, name: draft.name, base_version: draft.source?.version ?? null }; }
  private reserve() {
    if (this.reserved >= MAX_DRAFTS) throw new SkillDraftError("DRAFT_LIMIT", "Too many private drafts in one extraction");
    this.reserved++;
  }
  private async open(skillId: string, version?: number): Promise<Draft> {
    this.assertOpen();
    let opening = this.opened.get(skillId);
    if (!opening) {
      this.reserve();
      opening = (async () => {
        const source = structuredClone(await this.options.core.get({ ...this.readIds, skill_id: skillId, version, include_content: true, include_manifest: true }));
        this.assertOpen();
        if (source.skill_id !== skillId || !Number.isSafeInteger(source.version) || source.version < 1 || (version !== undefined && source.version !== version) || source.team_id !== this.options.team_id || source.team_id.length > 256 || typeof source.owner_agent_id !== "string" || source.owner_agent_id.length > 256) throw new SkillDraftError("DRAFT_SOURCE_MISMATCH", "Source identity/version/team does not match this bounded read");
        const body = contentBytes(source.name, source.content);
        const metadata: unknown = JSON.parse(source.metadata_json);
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new SkillDraftError("DRAFT_INVALID_METADATA", "Source metadata must be a JSON object");
        canonical(metadata); assertResourcePaths(source.manifest.map(r => r.path));
        for (const entry of source.manifest) {
          const checksum = (entry as typeof entry & { content_sha256?: string }).content_sha256;
          if (!Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0 || entry.size_bytes > MAX_RESOURCE_BYTES || typeof entry.mime_type !== "string" || Buffer.byteLength(entry.mime_type) > 256 || typeof entry.is_executable !== "boolean" || (checksum !== undefined && !/^[a-f0-9]{64}$/.test(checksum)) || Object.keys(entry).some(key => !["path", "size_bytes", "mime_type", "is_executable", "content_sha256"].includes(key))) throw new SkillDraftError("DRAFT_RESOURCE_INTEGRITY", "Invalid or unbounded source manifest attributes");
          assertUnicode(entry.mime_type);
        }
        if (source.manifest.length > 4096 || source.manifest.reduce((sum, r) => sum + r.size_bytes, 0) > MAX_PACKAGE_BYTES) throw new SkillDraftError("DRAFT_TOO_LARGE", "Source resource manifest exceeds package limits");
        const draft: Draft = { id: `draft:${hash(`${this.options.request_id}:source:${skillId}:${source.version}`).slice(0, 32)}`, revision: 0, name: source.name, content: source.content, body, read: [], source,
          metadata: metadata as Record<string, unknown>, resources: new Map(), loading: new Map(),
          readOnly: source.owner_agent_id !== this.options.agent_id ? "not-owner" : source.status !== "active" ? "archived" : isProtected(source.content, metadata as Record<string, unknown>) ? "protected" : undefined };
        this.drafts.set(draft.id, draft); return draft;
      })();
      this.opened.set(skillId, opening);
      opening.catch(() => { this.opened.delete(skillId); this.reserved--; });
    }
    const draft = await opening;
    this.assertOpen();
    if (version !== undefined && draft.source?.version !== version) throw new SkillDraftError("DRAFT_BASE_VERSION_CONFLICT", "This skill is already opened at a fixed base version");
    return draft;
  }
  async list(input: { query?: string; top_k?: number; offset?: number }) {
    this.assertOpen(); const limit = input.top_k ?? 20;
    const summarize = (s: Skill) => ({ skill_id: s.skill_id, version: s.version, name: s.name, description: s.description.slice(0, 1024) });
    if (input.query?.trim()) {
      const hits = await this.options.core.search({ ...this.readIds, query: input.query, top_k: limit });
      this.assertOpen(); return { items: hits.slice(0, limit).map(h => ({ ...summarize(h.skill), score: h.score })), total: hits.length };
    }
    const result = await this.options.core.list({ ...this.readIds, pagination: { limit, offset: input.offset ?? 0 } });
    this.assertOpen(); return { items: result.items.slice(0, limit).map(summarize), total: result.total };
  }
  async view(input: { skill_id?: string; version?: number; draft_id?: string; offset?: number; length?: number; manifest_offset?: number; manifest_limit?: number }) {
    const draft = input.draft_id ? this.get(input.draft_id) : await this.open(input.skill_id!, input.version);
    this.assertOpen();
    const part = page(draft.body, input.offset, input.length);
    const manifest = this.manifest(draft); const start = input.manifest_offset ?? 0; const limit = input.manifest_limit ?? 20;
    draft.read.push([part.offset, part.end]);
    return { ...this.receipt(draft), source_skill_id: draft.source?.skill_id, source_owner_agent_id: draft.source?.owner_agent_id ?? this.options.agent_id, team_id: draft.source?.team_id ?? this.options.team_id,
      read_only: Boolean(draft.readOnly), read_only_reason: draft.readOnly, content: part.bytes.toString("utf-8"), offset: part.offset, next_offset: part.next_offset, size_bytes: part.size_bytes,
      manifest: manifest.slice(start, start + limit), manifest_total: manifest.length, next_manifest_offset: start + limit < manifest.length ? start + limit : null,
      metadata_keys: Object.keys(draft.metadata).slice(0, 10).map(key => key.slice(0, 64)) };
  }
  create(input: { name: string; content: string; metadata?: Record<string, unknown> }) {
    this.assertOpen();
    if ([...this.drafts.values()].some(d => d.name === input.name)) throw new SkillDraftError("DRAFT_NAME_DUPLICATE", "This name already has a draft; edit that draft instead");
    const body = contentBytes(input.name, input.content); const metadata = structuredClone(input.metadata ?? {}); canonical(metadata);
    this.reserve();
    const draft: Draft = { id: `draft:${hash(`${this.options.request_id}:new:${this.sequence++}`).slice(0, 32)}`, revision: 0, name: input.name, content: input.content, body, read: [[0, body.length]], metadata, resources: new Map(), loading: new Map() };
    this.drafts.set(draft.id, draft); return this.receipt(draft);
  }
  update(input: { draft_id: string; expected_revision: number; content: string }) {
    const draft = this.writable(input.draft_id, input.expected_revision);
    if (!covered(draft.read, draft.body.length)) throw new SkillDraftError("DRAFT_BODY_UNREAD", "Read every body page before replacing it");
    draft.body = contentBytes(draft.name, input.content); draft.content = input.content; draft.read = [[0, draft.body.length]]; draft.revision++;
    return this.receipt(draft);
  }
  patch(input: { draft_id: string; expected_revision: number; old_string: string; new_string: string; replace_all?: boolean }) {
    const draft = this.writable(input.draft_id, input.expected_revision);
    if (!input.old_string) throw new SkillDraftError("DRAFT_PATCH_NOT_UNIQUE", "old_string cannot be empty");
    const count = draft.content.split(input.old_string).length - 1;
    if (!count || (count > 1 && !input.replace_all)) throw new SkillDraftError("DRAFT_PATCH_NOT_UNIQUE", "old_string must exist uniquely, unless replace_all is explicitly safe");
    return this.update({ ...input, content: input.replace_all ? draft.content.split(input.old_string).join(input.new_string) : draft.content.replace(input.old_string, input.new_string) });
  }
  private manifest(draft: Draft) {
    const entries = new Map((draft.source?.manifest ?? []).map(r => [r.path, { ...r }]));
    for (const [path, resource] of draft.resources) {
      if (!resource.authored && entries.has(path)) continue;
      entries.set(path, { path, size_bytes: resource.bytes.length, mime_type: resource.payload.mime_type ?? "application/octet-stream", is_executable: resource.payload.is_executable ?? false });
    }
    return [...entries.values()];
  }
  private async resource(draft: Draft, path: string): Promise<ResourceDraft> {
    assertResourcePath(path);
    const cached = draft.resources.get(path); if (cached) return cached;
    const existing = draft.source?.manifest.find(r => r.path === path);
    if (!existing || !draft.source) throw new SkillDraftError("DRAFT_RESOURCE_NOT_FOUND", "Resource path is not owned by this draft");
    let loading = draft.loading.get(path);
    if (!loading) {
      loading = (async () => {
        const read = await this.options.core.readFile({ ...this.readIds, skill_id: draft.source!.skill_id, version: draft.source!.version, path, encoding: "base64" });
        const bytes = resourceBytes(read);
        const checksum = (existing as typeof existing & { content_sha256?: string }).content_sha256;
        if (read.version !== draft.source!.version || read.path !== path || bytes.length !== existing.size_bytes || read.size_bytes !== bytes.length || (checksum !== undefined && hash(bytes) !== checksum)) throw new SkillDraftError("DRAFT_RESOURCE_INTEGRITY", "Fixed-version resource bytes do not match its manifest");
        if (bytes.length > MAX_RESOURCE_BYTES) throw new SkillDraftError("DRAFT_TOO_LARGE", "Resource exceeds 5MB");
        const resource: ResourceDraft = { bytes, read: [], payload: { path, content: bytes.toString("base64"), encoding: "base64", mime_type: existing.mime_type, is_executable: existing.is_executable } };
        draft.resources.set(path, resource); return resource;
      })();
      draft.loading.set(path, loading);
      loading.catch(() => { draft.loading.delete(path); });
    }
    return loading;
  }
  async readFile(input: { draft_id: string; path: string; offset?: number; length?: number; encoding?: "utf-8" | "base64" }) {
    const draft = this.get(input.draft_id); const resource = await this.resource(draft, input.path); this.assertOpen();
    const encoding = input.encoding ?? (isTextResource(resource.payload) ? "utf-8" : "base64");
    if (encoding === "utf-8") new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(resource.bytes);
    const part = page(resource.bytes, input.offset, input.length, encoding === "utf-8");
    resource.read.push([part.offset, part.end]);
    return { ...this.receipt(draft), path: input.path, content: part.bytes.toString(encoding === "base64" ? "base64" : "utf-8"), encoding, offset: part.offset, next_offset: part.next_offset, size_bytes: part.size_bytes, mime_type: resource.payload.mime_type, is_executable: resource.payload.is_executable };
  }
  writeFile(input: { draft_id: string; expected_revision: number; path: string; content: string; encoding?: "utf-8" | "base64"; mime_type?: string; is_executable?: boolean }) {
    const draft = this.writable(input.draft_id, input.expected_revision); assertResourcePath(input.path);
    const current = draft.resources.get(input.path); const source = draft.source?.manifest.find(r => r.path === input.path);
    if ((source || current) && (!current || !covered(current.read, current.bytes.length))) throw new SkillDraftError("DRAFT_RESOURCE_UNREAD", "Read all resource bytes before overwriting it");
    const payload: SkillResourcePayload = { path: input.path, content: input.content, encoding: input.encoding ?? "utf-8", mime_type: input.mime_type ?? current?.payload.mime_type ?? source?.mime_type ?? (input.encoding === "base64" ? "application/octet-stream" : "text/plain"), is_executable: input.is_executable ?? current?.payload.is_executable ?? source?.is_executable ?? false };
    const bytes = resourceBytes(payload);
    if (bytes.length > MAX_RESOURCE_BYTES) throw new SkillDraftError("DRAFT_TOO_LARGE", "Resource exceeds 5MB");
    const manifest = this.manifest(draft).filter(r => r.path !== input.path);
    assertResourcePaths([...manifest.map(r => r.path), input.path]);
    if (manifest.reduce((sum, r) => sum + r.size_bytes, 0) + bytes.length > MAX_PACKAGE_BYTES) throw new SkillDraftError("DRAFT_TOO_LARGE", "Resources exceed 50MB");
    draft.resources.set(input.path, { payload, bytes, read: [[0, bytes.length]], authored: true }); draft.revision++;
    return this.receipt(draft);
  }
  async finalize(): Promise<SkillDraftBatch> {
    this.assertOpen(); this.closed = true;
    const candidates: SkillCandidateSubmission[] = []; let total = 0;
    for (const draft of this.drafts.values()) {
      if (draft.readOnly) continue;
      const resources: SkillResourcePayload[] = [];
      const privateReference = /\bdraft:[a-f0-9]{32}\b/;
      const metadataText = canonical(draft.metadata);
      if (privateReference.test(draft.content) || privateReference.test(metadataText)) throw new SkillDraftError("DRAFT_PRIVATE_REFERENCE", "Private draft IDs cannot be written into final packages");
      let resourceTotal = 0;
      for (const entry of this.manifest(draft)) {
        const resource = await this.resource(draft, entry.path);
        if (isTextResource(resource.payload)) new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(resource.bytes);
        // Inspect ASCII handles in opaque bytes without forcing binary content into model context.
        if (privateReference.test(resource.bytes.toString("latin1"))) throw new SkillDraftError("DRAFT_PRIVATE_REFERENCE", "Private draft IDs cannot be written into final resource bytes");
        resources.push({ ...resource.payload }); resourceTotal += resource.bytes.length;
      }
      const candidate = { name: draft.name, content: draft.content, resources, metadata: structuredClone(draft.metadata) };
      total += draft.body.length + Buffer.byteLength(metadataText) + resourceTotal;
      if (total > MAX_BATCH_BYTES) throw new SkillDraftError("DRAFT_TOO_LARGE", "Private batch exceeds 100MB");
      candidates.push({ request_id: `candidate:${hash(`${this.options.request_id}:${draft.id}`)}`, user_id: this.options.user_id,
        team_id: draft.source?.team_id ?? this.options.team_id, agent_id: draft.source?.owner_agent_id ?? this.options.agent_id, task_id: this.options.task_id,
        source: draft.source ? { skill_id: draft.source.skill_id, expected_version: draft.source.version } : undefined, candidate });
    }
    return { candidates };
  }
}
