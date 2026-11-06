/**
 * Publishes immutable skill packages. Resources use attempt-local directories;
 * database/metadata authority decides visibility. Unknown outcomes retain bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ISkillStore } from "./skill-store.interface.js";
import { IdempotentNoOpError, SkillStoreError, assertSkillExpectedVersion, assertSkillMutationMatch, canonicalSkillJson } from "./skill-store.interface.js";
import { SkillResourceStore, SkillResourceError, type SkillResourcePayload } from "./skill-resource-store.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { AppendVersionInput, SkillManifestEntry, Skill } from "./types.js";

function computeContentHash(content: string): string {
  return createHash("md5").update(content, "utf-8").digest("hex");
}

function isDefinitePublicationFailure(error: unknown): boolean {
  // Trusted store/coordinator errors share a code contract, not necessarily an
  // Error subclass (the external authority owns its own error implementation).
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return typeof error.code === "string" && ["SKILL_VERSION_STALE", "SKILL_MUTATION_CONFLICT", "SKILL_NAME_DUPLICATE",
    "SKILL_NOT_FOUND", "SKILL_PUBLICATION_COORDINATOR_REQUIRED"].includes(error.code);
}

export interface AppendVersionContext {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
}

export interface AppendVersionMutation {
  /** Stable request intent; reuse for retry, never for another payload. */
  mutation_id?: string;
  /** Defaults to supplied head version, or 0 when creating. */
  expected_version?: number;
  content: string;
  name: string;
  description: string;
  resourcesToWrite?: SkillResourcePayload[];
  resourcesToRemove?: string[];
  /** Replace metadata; omitted means inherit the previous version. */
  metadata_json?: string;
}

export interface SkillVersioningOptions {
  store: ISkillStore;
  resources: SkillResourceStore;
  storage: StorageAdapter;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  onSkillVdbChanged?: (delta: number) => void;
  /** Idempotent asset registration after confirmed DB publication, retried on
   * create replay. Failure reports pending registration, never deletes content. */
  onSkillCreated?: (params: {
    skill_id: string;
    team_id?: string;
    agent_id?: string;
    user_id?: string;
    name: string;
    description: string;
  }) => Promise<void>;
}

export class SkillVersioning {
  private readonly store: ISkillStore;
  private readonly resources: SkillResourceStore;
  private readonly storage: StorageAdapter;
  private readonly logger?: SkillVersioningOptions["logger"];
  private readonly onSkillVdbChanged?: (delta: number) => void;
  private readonly onSkillCreated?: SkillVersioningOptions["onSkillCreated"];

  constructor(opts: SkillVersioningOptions) {
    this.store = opts.store;
    this.resources = opts.resources;
    this.storage = opts.storage;
    this.logger = opts.logger;
    this.onSkillVdbChanged = opts.onSkillVdbChanged;
    this.onSkillCreated = opts.onSkillCreated;
  }

  async createNewSkill(skillId: string, ownerAgentId: string, ctx: AppendVersionContext, mut: AppendVersionMutation): Promise<Skill> {
    return this.publish(null, skillId, ownerAgentId, ctx, mut);
  }

  async appendNextVersion(head: Skill, ctx: AppendVersionContext, mut: AppendVersionMutation): Promise<Skill> {
    return this.publish(head, head.skill_id, head.owner_agent_id, ctx, mut);
  }

  private async publish(
    head: Skill | null, skillId: string, ownerAgentId: string,
    ctx: AppendVersionContext, mut: AppendVersionMutation,
  ): Promise<Skill> {
    const expected = mut.expected_version ?? head?.version ?? 0;
    const mutationId = mut.mutation_id ?? randomUUID();
    const requestHash = createHash("sha256").update(canonicalSkillJson({
      skillId, ownerAgentId, ctx, expected,
      content: mut.content, name: mut.name, description: mut.description,
      metadata_json: mut.metadata_json ?? head?.metadata_json ?? "{}",
      resourcesToWrite: (mut.resourcesToWrite ?? []).map(p => ({ ...p,
        content: Buffer.from(p.content, p.encoding === "base64" ? "base64" : "utf8").toString("base64"),
        encoding: "base64",
      })),
      resourcesToRemove: mut.resourcesToRemove ?? [],
    })).digest("hex");

    // Resolve retries before touching either the committed directory or today's
    // head. An unavailable lookup is not proof of absence.
    const replay = await this.store.getByMutationId(skillId, mutationId, ctx.team_id);
    if (replay) {
      if (replay.mutation_request_hash !== requestHash) throw new SkillStoreError("SKILL_MUTATION_CONFLICT");
      if (!head) await this.registerCreatedSkill(replay, ctx);
      return replay;
    }
    const precondition = { expected_version: expected, mutation_id: mutationId };
    assertSkillExpectedVersion(precondition, head);
    assertSkillExpectedVersion(precondition, await this.store.getHeadIncludingArchived(skillId, ctx.team_id));

    const newVersion = expected + 1;
    // The intent prefix aids recovery; the attempt suffix prevents simultaneous
    // retries from overwriting or cleaning up each other's prepared bytes.
    const intentKey = createHash("sha256").update(mutationId).digest("hex").slice(0, 24);
    const storageDir = `${this.resources.versionDir(skillId, newVersion)}/attempts/${intentKey}-${randomUUID()}`;
    const original = new Map<string, SkillResourcePayload>();
    const replacements = new Set((mut.resourcesToWrite ?? []).map(resource => resource.path));
    const removals = new Set(mut.resourcesToRemove ?? []);
    for (const entry of head?.manifest ?? []) {
      if (removals.has(entry.path) && !replacements.has(entry.path)) continue;
      const data = await this.resources.readResource(skillId, head!.version, entry.path, "base64", head!.storage_dir).catch(error => {
        if (replacements.has(entry.path)) return null;
        throw error;
      });
      const digest = data ? createHash("sha256").update(Buffer.from(data.content, "base64")).digest("hex") : undefined;
      if (!data || data.size_bytes !== entry.size_bytes || (entry.content_sha256 && digest !== entry.content_sha256)) {
        if (replacements.has(entry.path)) continue;
        throw new SkillResourceError("RESOURCE_INTEGRITY_ERROR", `manifest resource missing or corrupt: ${entry.path}`);
      }
      original.set(entry.path, { path: entry.path, content: data.content, encoding: "base64",
        mime_type: entry.mime_type, is_executable: entry.is_executable });
    }
    const desired = new Map(original);
    for (const path of mut.resourcesToRemove ?? []) desired.delete(path);
    for (const p of mut.resourcesToWrite ?? []) desired.set(p.path, p);
    this.resources.assertTotalSize([], [...desired.values()], []);

    const manifest: SkillManifestEntry[] = [];
    try {
      for (const payload of desired.values()) {
        manifest.push(await this.resources.writeResource(skillId, newVersion, payload, storageDir));
      }
      // Compare actual decoded bytes and file metadata, not "writes requested".
      const oldManifest = head && original.size === head.manifest.length ? head.manifest.map(e => ({ ...e,
        content_sha256: createHash("sha256").update(Buffer.from(original.get(e.path)!.content, "base64")).digest("hex"),
      })) : undefined;
      const sorted = (entries: SkillManifestEntry[]) => [...entries].sort((a, b) => a.path.localeCompare(b.path));
      if (head && oldManifest && !mut.mutation_id && head.content === mut.content && head.name === mut.name &&
          head.description === mut.description && head.metadata_json === (mut.metadata_json ?? head.metadata_json) &&
          canonicalSkillJson(sorted(oldManifest)) === canonicalSkillJson(sorted(manifest))) {
        // An explicit intent needs a durable receipt; legacy no-ops do not.
        assertSkillExpectedVersion(precondition, await this.store.getHeadIncludingArchived(skillId, ctx.team_id));
        await this.cleanupVersionDir(storageDir);
        return head;
      }
    } catch (err) {
      await this.cleanupVersionDir(storageDir);
      throw err;
    }

    const input: AppendVersionInput = {
      ...ctx, skill_id: skillId, owner_agent_id: ownerAgentId,
      expected_version: expected, mutation_id: mutationId, mutation_request_hash: requestHash,
      name: mut.name, description: mut.description, content: mut.content,
      content_hash: computeContentHash(mut.content), manifest, storage_dir: storageDir,
      metadata_json: mut.metadata_json ?? head?.metadata_json ?? "{}",
    };
    let row: Skill;
    try {
      row = await this.store.appendVersion(input);
    } catch (err) {
      // Three outcomes, not two. Only strict receipt lookup can convert a lost
      // acknowledgement into success. Unknown outcomes retain prepared bytes.
      let committed: Skill | null;
      try {
        committed = await this.store.getByMutationId(skillId, mutationId, ctx.team_id);
      } catch {
        throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", `mutation ${mutationId}; prepared directory ${storageDir}`);
      }
      if (committed) {
        // A committed sibling is proof that this distinct attempt cannot win.
        if (committed.storage_dir !== storageDir) await this.cleanupVersionDir(storageDir);
        row = assertSkillMutationMatch(committed, input);
      } else if (isDefinitePublicationFailure(err)) {
        await this.cleanupVersionDir(storageDir);
        throw err;
      } else {
        // A negative remote read cannot prove an in-flight request won't commit.
        throw new SkillStoreError("SKILL_PUBLICATION_UNKNOWN", `mutation ${mutationId}; prepared directory ${storageDir}`);
      }
    }
    if (row.storage_dir !== storageDir) await this.cleanupVersionDir(storageDir);
    else this.onSkillVdbChanged?.(1);
    if (!head) await this.registerCreatedSkill(row, ctx);
    return row;
  }

  private async registerCreatedSkill(row: Skill, ctx: AppendVersionContext): Promise<void> {
    if (!this.onSkillCreated) return;
    try {
      await this.onSkillCreated({ skill_id: row.skill_id, ...ctx, name: row.name, description: row.description });
    } catch {
      // The receipt and resource directory are already committed. The caller
      // may retry this idempotent hook through the same create mutation; neither
      // that replay nor an asset failure may recreate/delete versions or recount
      // the physical publication's usage delta.
      throw new SkillStoreError("SKILL_ASSET_REGISTRATION_PENDING",
        `skill_id=${row.skill_id} mutation_id=${row.mutation_id ?? "-"}; publication committed, asset registration requires retry`);
    }
  }

  private async cleanupVersionDir(dir: string): Promise<void> {
    if (!dir) return;
    try { await this.storage.rmdir(dir); } catch {
      this.logger?.warn(`[skill-publication] orphan resource directory retained: ${dir}`);
    }
  }

  async removeVersionDirectory(storageDir: string): Promise<void> {
    await this.storage.rmdir(storageDir);
  }

  reportDeletedVersions(count: number): void {
    if (count > 0) this.onSkillVdbChanged?.(-count);
  }

  /** Delete DB versions first, then their recorded directories. Authorization is the caller's responsibility. */
  async deleteSkill(skillId: string, teamId?: string, opts?: { reportVdbDelta?: boolean }): Promise<number> {
    const versions = await this.store.listVersions(skillId, teamId, { limit: 1000, offset: 0 });
    const deleted = await this.store.deleteAllVersions(skillId, teamId);
    if (deleted <= 0) return 0;
    for (const v of versions) {
      if (!v.storage_dir) continue;
      try { await this.storage.rmdir(v.storage_dir); } catch {
        this.logger?.warn(`[skill-delete] storage rmdir failed for ${v.storage_dir}`);
      }
    }
    if (opts?.reportVdbDelta ?? true) this.onSkillVdbChanged?.(-deleted);
    return deleted;
  }

  private static readonly KEEP_RECENT = 3;
  private static readonly LIST_LIMIT = 1000;

  /** Existing TTL/count policy; deletion only follows a successful store delete. */
  async cleanupExpiredVersionsForSkill(skillId: string, ttlSeconds: number, maxNonHeadVersions = 0, now?: number): Promise<void> {
    if (ttlSeconds <= 0 && maxNonHeadVersions <= 0) return;
    const all = await this.store.listVersions(skillId, undefined, { limit: SkillVersioning.LIST_LIMIT, offset: 0 });
    if (!all.length) return;
    const head = all.find(v => v.is_head);
    if (!head || head.status === "archived") return;
    const sorted = [...all].sort((a, b) => b.version - a.version);
    const nonHeadSorted = sorted.filter(v => !v.is_head);
    const toDelete = new Set<number>();
    if (maxNonHeadVersions > 0 && nonHeadSorted.length > maxNonHeadVersions) {
      for (const v of nonHeadSorted.slice(maxNonHeadVersions)) toDelete.add(v.version);
    }
    if (ttlSeconds > 0) {
      const cutoffMs = (now ?? Date.now()) - ttlSeconds * 1000;
      const protectedVersions = new Set(nonHeadSorted.slice(0, SkillVersioning.KEEP_RECENT).map(v => v.version));
      for (const v of nonHeadSorted) {
        if (!protectedVersions.has(v.version) && v.created_at_ms < cutoffMs) toDelete.add(v.version);
      }
    }
    const metaByVersion = new Map(nonHeadSorted.map(v => [v.version, v]));
    for (const version of toDelete) {
      const v = metaByVersion.get(version);
      if (!v || !(await this.store.deleteVersion(v.skill_id, version))) continue;
      this.onSkillVdbChanged?.(-1);
      try { await this.storage.rmdir(v.storage_dir); } catch {
        this.logger?.warn(`[skill-ttl] storage rmdir failed for ${v.storage_dir}`);
      }
    }
  }
}

export { IdempotentNoOpError, SkillStoreError, SkillResourceError };
