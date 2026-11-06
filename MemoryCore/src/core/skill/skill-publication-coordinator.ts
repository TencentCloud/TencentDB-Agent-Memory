import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { AtomicSkillStateStore, SkillStateRecord } from "./skill-state-store.js";
import {
  assertSkillDeletionTargets, MAX_SKILL_DELETION_BYTES, MAX_SKILL_DELETION_TARGETS,
  type SkillPublicationCoordinator, type SkillPublicationLookup, type SkillPublicationPointer, type SkillPublicationRequest, type SkillPublicationScope,
  type SkillDeletionRequest, type SkillDeletionReceipt, type SkillDeletionTarget, type SkillDeletionGuard, type SkillDeletionResult,
} from "./skill-store.interface.js";
import type { Skill } from "./types.js";

const pointerSchema = z.object({ row_id: z.string(), version: z.number().int().positive(), mutation_id: z.string(), status: z.enum(["active", "archived"]).optional() });
const leaseSchema = z.object({ token: z.string(), mutation_id: z.string(), expires_at: z.number() });
const receiptReferenceSchema = z.object({ mutation_id: z.string(), payload_hash: z.string(), row_id: z.string().min(1), version: z.number().int().positive() });
// Existing embedded receipts are projected to references when read; subsequent
// head writes compact them. Recovery still requires a matching persisted intent.
const receiptSchema = z.union([receiptReferenceSchema, z.object({
  mutation_id: z.string(), payload_hash: z.string(),
  skill: z.object({ row_id: z.string().min(1), version: z.number().int().positive() }),
}).transform(({ mutation_id, payload_hash, skill }) => ({ mutation_id, payload_hash, row_id: skill.row_id, version: skill.version }))]);
const headSchema = z.object({ kind: z.literal("head"), scope: z.object({ team_id: z.string(), skill_id: z.string() }), name: z.string(), owner_agent_id: z.string(), pointer: pointerSchema.nullable(), deleted: z.boolean(), fence: z.number().int(), lease: leaseSchema.nullable(), receipt: receiptSchema.optional(), cleanup_pending: z.boolean().optional(), deletion_id: z.string().optional() });
const intentSchema = z.object({ kind: z.literal("intent"), scope: z.object({ team_id: z.string(), skill_id: z.string() }), mutation_id: z.string(), payload_hash: z.string(), phase: z.enum(["preparing", "committing", "committed", "failed", "unknown"]), token: z.string().optional(), fence: z.number().int().nonnegative().optional(), skill: z.unknown().optional() });
const deletionSchema = z.object({
  kind: z.literal("deletion"), deletion_id: z.string().min(1),
  scope: z.object({ team_id: z.string().min(1), skill_id: z.string().min(1) }),
  owner_agent_id: z.string().min(1), name: z.string().min(1), original_head: pointerSchema,
  phase: z.enum(["pending", "complete"]),
  targets: z.array(z.object({ row_id: z.string().min(1), version: z.number().int().positive(), storage_dir: z.string() })).max(MAX_SKILL_DELETION_TARGETS),
  created_at_ms: z.number(), token: z.string().min(1), fence: z.number().int().nonnegative(), completed_by: z.string().optional(),
});
const deletionIndexSchema = z.object({ kind: z.literal("deletion-index"), skill_id: z.string().min(1),
  scopes: z.array(z.object({ team_id: z.string().min(1), skill_id: z.string().min(1) })).max(256) });
type Deletion = z.infer<typeof deletionSchema>;
type Head = z.infer<typeof headSchema>;
type Intent = z.infer<typeof intentSchema>;
type Receipt = z.infer<typeof receiptSchema>;

export class SkillPublicationError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "SkillPublicationError"; }
}

export interface PersistentSkillPublicationOptions {
  store: AtomicSkillStateStore;
  /** Instance identity: control keys must not collide across services sharing a metadata database. */
  namespace: string;
  leaseMs?: number;
  now?: () => number;
  heartbeat?: boolean;
}

export class PersistentSkillPublicationCoordinator implements SkillPublicationCoordinator {
  private readonly state: AtomicSkillStateStore;
  private readonly prefix: string;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly heartbeat: boolean;

  constructor(options: PersistentSkillPublicationOptions) {
    if (!options.namespace) throw new Error("skill publication namespace is required");
    this.state = options.store;
    this.prefix = `skill-publication/${hash(options.namespace)}/`;
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 100) throw new Error("publication lease must be at least 100 ms");
    this.now = options.now ?? Date.now;
    this.heartbeat = options.heartbeat ?? true;
  }

  async getHead(scope: SkillPublicationScope): Promise<SkillPublicationPointer | null | undefined> {
    const head = await this.readHead(scope);
    return head ? head.value.pointer : undefined;
  }

  /** Lightweight ordered projection; never loads full intent/skill payloads. */
  async getHeads(scopes: SkillPublicationScope[]): Promise<Array<SkillPublicationPointer | null | undefined>> {
    if (!Array.isArray(scopes) || scopes.length > 1000) throw new RangeError("getHeads accepts at most 1000 scopes");
    if (scopes.length === 0) return [];
    const keys = scopes.map(scope => this.headKey(scope));
    let rows: Array<SkillStateRecord | null>;
    if (this.state.readMany) {
      rows = await this.state.readMany(keys);
      if (rows.length !== scopes.length) throw failure("SKILL_PUBLICATION_UNKNOWN", "incomplete head batch response");
    } else {
      rows = new Array(keys.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(8, keys.length) }, async () => {
        while (next < keys.length) {
          const index = next++;
          rows[index] = await this.state.read(keys[index]);
        }
      }));
    }
    return rows.map((row, index) => this.parseHead(scopes[index], row)?.value.pointer);
  }

  async getDeletionReceipt(scope: { skill_id: string; team_id?: string }): Promise<SkillDeletionReceipt | null> {
    if (scope.team_id !== undefined) return this.qualifiedDeletionReceipt({ skill_id: scope.skill_id, team_id: scope.team_id });
    // Optional identity is retained for instance-admin callers. The index is
    // persisted before tombstoning, so lookup does not depend on surviving rows.
    const index = await this.state.read(this.deletionIndexKey(scope.skill_id));
    if (!index) return null;
    const parsed = deletionIndexSchema.safeParse(index.value);
    if (!parsed.success || parsed.data.skill_id !== scope.skill_id || parsed.data.scopes.some(item => item.skill_id !== scope.skill_id)) {
      throw failure("SKILL_PUBLICATION_UNKNOWN", "invalid deletion scope index");
    }
    let result: SkillDeletionReceipt | null = null;
    for (const item of parsed.data.scopes) {
      const receipt = await this.qualifiedDeletionReceipt(item);
      if (!receipt) continue;
      if (result) throw failure("SKILL_PUBLICATION_UNKNOWN", "multiple deletion scopes require an explicit team_id");
      result = receipt;
    }
    return result;
  }

  private async qualifiedDeletionReceipt(scope: SkillPublicationScope): Promise<SkillDeletionReceipt | null> {
    const head = await this.readHead(scope);
    // A null pointer also occurs during a first publication. It is not deletion
    // authority and must never permit cleanup of arbitrary candidate rows.
    if (!head?.value.deleted) return null;
    const record = await this.readDeletion(scope);
    if (!record || record.value.deletion_id !== head.value.deletion_id ||
        record.value.owner_agent_id !== head.value.owner_agent_id || record.value.name !== head.value.name) {
      throw failure("SKILL_PUBLICATION_UNKNOWN", "deleted tombstone has no matching authorized cleanup receipt");
    }
    return this.deletionReceipt(record.value);
  }

  async deleteWithReceipt(
    request: SkillDeletionRequest,
    prepare: (guard: SkillDeletionGuard) => Promise<SkillDeletionTarget[]>,
    cleanup: (receipt: SkillDeletionReceipt, guard: SkillDeletionGuard) => Promise<number>,
    options: { complete?: boolean } = {},
  ): Promise<SkillDeletionResult> {
    if (!request.scope.team_id || !request.scope.skill_id || !request.owner_agent_id) throw failure("SKILL_NOT_OWNER", "deletion requires the original owner and team");
    const prior = await this.getDeletionReceipt(request.scope);
    if (prior) {
      this.assertDeletionOwner(request, prior);
      assertSkillDeletionTargets(request.scope, prior.targets, request.versionDirectory);
      if (prior.phase === "complete") return { receipt: prior, completed_now: false, deleted_rows: 0 };
    }
    const token = randomUUID();
    const acquired = await this.acquireDeletion(request, token);
    let leaseLost = false;
    let renewal: Promise<void> | undefined;
    const guard = async () => {
      if (leaseLost) throw failure("SKILL_VERSION_STALE", "deletion cleanup lease was lost");
      await this.ownedDeletionHead(request.scope, token);
    };
    const timer = this.heartbeat ? setInterval(() => {
      if (renewal) return;
      renewal = this.renewDeletion(request.scope, token).catch(() => { leaseLost = true; }).finally(() => { renewal = undefined; });
    }, Math.max(50, Math.floor(this.leaseMs / 3))) : undefined;
    timer?.unref();
    let deletedRows = 0;
    try {
      let receipt: SkillDeletionReceipt;
      if (acquired.value.deleted) {
        const existing = await this.getDeletionReceipt(request.scope);
        if (!existing) throw failure("SKILL_PUBLICATION_UNKNOWN", "deletion receipt disappeared");
        this.assertDeletionOwner(request, existing);
        assertSkillDeletionTargets(request.scope, existing.targets, request.versionDirectory);
        if (existing.phase === "complete") return { receipt: existing, completed_now: false, deleted_rows: 0 };
        receipt = existing;
      } else {
        const targets = await prepare(guard);
        await guard();
        assertSkillDeletionTargets(request.scope, targets, request.versionDirectory);
        const original = acquired.value.pointer;
        if (!original || !targets.some(target => target.row_id === original.row_id && target.version === original.version)) {
          throw failure("SKILL_PUBLICATION_UNKNOWN", "deletion plan is missing the authorized head row");
        }
        const plan: Deletion = { kind: "deletion", deletion_id: randomUUID(), scope: request.scope,
          owner_agent_id: acquired.value.owner_agent_id, name: acquired.value.name, original_head: original,
          phase: "pending", targets, created_at_ms: this.now(), token, fence: acquired.value.fence };
        if (Buffer.byteLength(JSON.stringify(plan), "utf8") > MAX_SKILL_DELETION_BYTES) {
          throw failure("RESOURCE_TOO_LARGE", "deletion receipt exceeds 900000 bytes; no tombstone was committed");
        }
        await this.saveDeletionPlan(plan, guard);
        await this.indexDeletionScope(request.scope, guard);
        let tombstoned = false;
        for (let attempt = 0; attempt < 16; attempt++) {
          const head = await this.ownedDeletionHead(request.scope, token);
          if (head.value.deleted || head.value.pointer?.row_id !== original.row_id) throw failure("SKILL_VERSION_STALE", "head changed before deletion");
          if (await this.state.compareAndSet(this.headKey(request.scope), head.revision, { ...head.value,
            pointer: null, deleted: true, cleanup_pending: true, deletion_id: plan.deletion_id })) { tombstoned = true; break; }
        }
        if (!tombstoned) throw failure("SKILL_PUBLICATION_BUSY", "deletion tombstone remained contended");
        receipt = this.deletionReceipt(plan);
      }
      await guard();
      deletedRows = await cleanup(receipt, guard);
      await guard();
      // Row-only store callers leave resources/hooks pending for Core to resume.
      if (options.complete === false) return { receipt, completed_now: false, deleted_rows: deletedRows };
      for (let attempt = 0; attempt < 16; attempt++) {
        await guard();
        const record = await this.readDeletion(request.scope);
        if (!record || record.value.deletion_id !== receipt.deletion_id) throw failure("SKILL_PUBLICATION_UNKNOWN", "cleanup receipt changed");
        if (record.value.phase === "complete") return { receipt: this.deletionReceipt(record.value), completed_now: record.value.completed_by === token, deleted_rows: deletedRows };
        const completed: Deletion = { ...record.value, phase: "complete", completed_by: token };
        if (await this.state.compareAndSet(this.deletionKey(request.scope), record.revision, completed)) {
          const head = await this.ownedDeletionHead(request.scope, token);
          await this.state.compareAndSet(this.headKey(request.scope), head.revision, { ...head.value, cleanup_pending: false });
          return { receipt: this.deletionReceipt(completed), completed_now: true, deleted_rows: deletedRows };
        }
      }
      throw failure("SKILL_PUBLICATION_BUSY", "cleanup completion remained contended");
    } catch (error) {
      let resolved: SkillDeletionReceipt | null;
      try { resolved = await this.getDeletionReceipt(request.scope); }
      catch { throw failure("SKILL_PUBLICATION_UNKNOWN", "deletion outcome could not be recovered"); }
      if (!resolved) throw error; // target/prepare failure before tombstone: no delete took place
      if (resolved.phase === "complete") {
        const record = await this.readDeletion(request.scope);
        return { receipt: resolved, completed_now: record?.value.completed_by === token, deleted_rows: deletedRows };
      }
      throw failure("SKILL_DELETION_PENDING", `skill_id=${request.scope.skill_id} deletion_id=${resolved.deletion_id}; cleanup pending: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer) clearInterval(timer);
      await renewal;
      await this.release(request.scope, token).catch(() => {});
    }
  }

  private async acquireDeletion(request: SkillDeletionRequest, token: string) {
    let existing = await this.readHead(request.scope);
    if (!existing) {
      if (!request.previous_head) throw failure("SKILL_NOT_FOUND", "no published skill to delete");
      const previous = checkedSkill(request.previous_head, request.scope);
      if (!previous.owner_agent_id || previous.owner_agent_id !== request.owner_agent_id) throw failure("SKILL_NOT_OWNER", "legacy deletion owner mismatch");
      await this.state.create(this.headKey(request.scope), { kind: "head", scope: request.scope, name: previous.name,
        owner_agent_id: previous.owner_agent_id, pointer: { row_id: previous.row_id, version: previous.version,
          mutation_id: previous.mutation_id ?? `legacy:${previous.row_id}`, status: previous.status }, deleted: false, fence: 0, lease: null } satisfies Head);
    }
    for (let attempt = 0; attempt < 16; attempt++) {
      existing = await this.readHead(request.scope);
      if (!existing) throw failure("SKILL_PUBLICATION_UNKNOWN", "deletion head disappeared");
      let value = existing.value;
      // Upgrade old legacy status records only with the store-verified original row.
      if (!value.owner_agent_id && !value.deleted && request.previous_head && value.pointer?.row_id === request.previous_head.row_id) {
        const previous = checkedSkill(request.previous_head, request.scope);
        value = { ...value, owner_agent_id: previous.owner_agent_id, name: previous.name };
      }
      if (!value.owner_agent_id || value.owner_agent_id !== request.owner_agent_id) throw failure("SKILL_NOT_OWNER", "deletion owner mismatch");
      if (!value.deleted && (!value.pointer || value.pointer.row_id !== request.expected_head.row_id || value.pointer.version !== request.expected_head.version)) {
        throw failure("SKILL_VERSION_STALE", "deletion expected a different published head");
      }
      if (value.lease && value.lease.expires_at > this.now()) throw failure("SKILL_PUBLICATION_BUSY", "another publication or cleanup is active");
      await this.settleHead(value);
      const next: Head = { ...value, fence: value.fence + 1, lease: { token, mutation_id: "deletion-cleanup", expires_at: this.now() + this.leaseMs } };
      if (await this.state.compareAndSet(this.headKey(request.scope), existing.revision, next)) return { revision: existing.revision + 1, value: next };
    }
    throw failure("SKILL_PUBLICATION_BUSY", "deletion lease remained contended");
  }

  private async ownedDeletionHead(scope: SkillPublicationScope, token: string) {
    const head = await this.readHead(scope);
    if (!head || head.value.lease?.token !== token || head.value.lease.expires_at <= this.now()) throw failure("SKILL_VERSION_STALE", "deletion cleanup lease is no longer valid");
    return head;
  }
  private async renewDeletion(scope: SkillPublicationScope, token: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await this.ownedDeletionHead(scope, token);
      if (await this.state.compareAndSet(this.headKey(scope), head.revision, { ...head.value, lease: { ...head.value.lease!, expires_at: this.now() + this.leaseMs } })) return;
    }
    throw failure("SKILL_VERSION_STALE", "deletion renewal remained contended");
  }
  private assertDeletionOwner(request: SkillDeletionRequest, receipt: SkillDeletionReceipt): void {
    if (!sameScope(request.scope, receipt.scope) || request.owner_agent_id !== receipt.owner_agent_id) throw failure("SKILL_NOT_OWNER", "deletion receipt belongs to another owner or team");
    if (request.expected_head.row_id !== receipt.original_head.row_id || request.expected_head.version !== receipt.original_head.version) throw failure("SKILL_VERSION_STALE", "deletion receipt expected a different original head");
  }
  private deletionReceipt(value: Deletion): SkillDeletionReceipt {
    const { deletion_id, scope, owner_agent_id, name, original_head, phase, targets, created_at_ms } = value;
    return { deletion_id, scope, owner_agent_id, name, original_head, phase, targets, created_at_ms };
  }
  private async readDeletion(scope: SkillPublicationScope) {
    const record = await this.state.read(this.deletionKey(scope));
    if (!record) return null;
    const parsed = deletionSchema.safeParse(record.value);
    if (!parsed.success || !sameScope(parsed.data.scope, scope)) throw failure("SKILL_PUBLICATION_UNKNOWN", "invalid deletion receipt");
    return { revision: record.revision, value: parsed.data };
  }
  private async indexDeletionScope(scope: SkillPublicationScope, guard: SkillDeletionGuard): Promise<void> {
    const key = this.deletionIndexKey(scope.skill_id);
    for (let attempt = 0; attempt < 16; attempt++) {
      await guard();
      const current = await this.state.read(key);
      const existing = current ? deletionIndexSchema.parse(current.value) : { kind: "deletion-index" as const, skill_id: scope.skill_id, scopes: [] as SkillPublicationScope[] };
      if (existing.skill_id !== scope.skill_id || existing.scopes.some(item => item.skill_id !== scope.skill_id)) throw failure("SKILL_PUBLICATION_UNKNOWN", "invalid deletion index identity");
      if (existing.scopes.some(item => sameScope(item, scope))) return;
      if (existing.scopes.length >= 256) throw failure("RESOURCE_TOO_LARGE", "deletion identity has too many team scopes");
      const next = { ...existing, scopes: [...existing.scopes, scope] };
      const saved = current ? await this.state.compareAndSet(key, current.revision, next) : await this.state.create(key, next);
      if (saved) return;
    }
    throw failure("SKILL_PUBLICATION_BUSY", "deletion index remained contended");
  }
  private async saveDeletionPlan(value: Deletion, guard: SkillDeletionGuard): Promise<void> {
    const key = this.deletionKey(value.scope);
    for (let attempt = 0; attempt < 16; attempt++) {
      await guard();
      const current = await this.readDeletion(value.scope);
      if (current && (current.value.phase === "complete" || current.value.fence > value.fence ||
          (current.value.fence === value.fence && current.value.token !== value.token))) throw failure("SKILL_VERSION_STALE", "a newer deletion plan already exists");
      const saved = current ? await this.state.compareAndSet(key, current.revision, value) : await this.state.create(key, value);
      if (saved) return;
    }
    throw failure("SKILL_PUBLICATION_BUSY", "deletion plan remained contended");
  }

  async lookup(scope: SkillPublicationScope, mutationId: string): Promise<SkillPublicationLookup> {
    const intent = await this.readIntent(scope, mutationId);
    if (intent?.value.phase === "committed") return this.receipt(intent.value);
    const head = await this.readHead(scope);
    if (head?.value.receipt?.mutation_id === mutationId) {
      return this.persistReceipt(scope, head.value.receipt);
    }
    if (intent?.value.phase === "unknown" || intent?.value.phase === "committing") {
      if (!intent.value.token) return { status: "unknown" };
      if (head?.value.lease && head.value.lease.token === intent.value.token && head.value.lease.expires_at > this.now()) return { status: "unknown" };
      // Expiry alone is not proof: invalidate the old CAS revision before declaring absence.
      const resolved = await this.invalidate(scope, intent.value.token, mutationId);
      if (resolved.status !== "absent") return resolved;
      await this.failIntent(scope, mutationId, intent.value.token).catch(() => {});
    }
    return { status: "absent" };
  }

  async execute(request: SkillPublicationRequest, prepare: () => Promise<Skill>): Promise<Skill> {
    this.validateRequest(request);
    const replay = await this.lookup(request.scope, request.mutation_id);
    if (replay.status === "committed") return this.matchReplay(request, replay);
    if (replay.status === "unknown") throw failure("SKILL_PUBLICATION_UNKNOWN", "previous publication outcome is not yet resolved");
    await this.ensureIntent(request);
    const token = randomUUID();
    await this.acquire(request, token);
    let leaseLost = false;
    let renewal: Promise<void> | undefined;
    const timer = this.heartbeat ? setInterval(() => {
      if (renewal) return;
      renewal = this.renew(request.scope, token).catch(() => { leaseLost = true; }).finally(() => { renewal = undefined; });
    }, Math.max(50, Math.floor(this.leaseMs / 3))) : undefined;
    timer?.unref();
    try {
      await this.setIntent(request, token, "preparing");
      const candidate = { ...checkedSkill(await prepare(), request.scope), is_head: true };
      if (candidate.status !== "active" || candidate.name !== request.name || candidate.owner_agent_id !== request.owner_agent_id ||
          (request.expected_version !== undefined && candidate.version !== request.expected_version + 1) ||
          (candidate.mutation_id && candidate.mutation_id !== request.mutation_id) ||
          (candidate.mutation_payload_hash && candidate.mutation_payload_hash !== request.payload_hash)) {
        throw failure("SKILL_MUTATION_CONFLICT", "prepared candidate does not match publication intent");
      }
      if (leaseLost) throw failure("SKILL_VERSION_STALE", "publication lease was lost");
      await this.setIntent(request, token, "committing", candidate);
      const receipt: Receipt = { mutation_id: request.mutation_id, payload_hash: request.payload_hash, row_id: candidate.row_id, version: candidate.version };
      for (let attempt = 0; attempt < 16; attempt++) {
        const head = await this.ownedHead(request.scope, token);
        if (candidate.version !== (head.value.pointer?.version ?? 0) + 1) throw failure("SKILL_VERSION_STALE", "prepared version is no longer next");
        await this.assertNameOwner(request);
        const next: Head = { ...head.value, pointer: { row_id: candidate.row_id, version: candidate.version, mutation_id: request.mutation_id, status: "active" }, receipt };
        if (await this.state.compareAndSet(this.headKey(request.scope), head.revision, next)) {
          await this.persistReceipt(request.scope, receipt);
          return candidate;
        }
      }
      throw failure("SKILL_PUBLICATION_BUSY", "publication head remained contended");
    } catch (error) {
      try {
        const resolved = await this.invalidate(request.scope, token, request.mutation_id);
        if (resolved.status === "committed") return this.matchReplay(request, resolved);
        if (resolved.status === "unknown") throw failure("SKILL_PUBLICATION_UNKNOWN", "could not fence an unconfirmed commit");
        await this.failIntent(request.scope, request.mutation_id, token);
      } catch (recoveryError) {
        if (recoveryError instanceof SkillPublicationError && recoveryError.code === "SKILL_MUTATION_CONFLICT") throw recoveryError;
        throw failure("SKILL_PUBLICATION_UNKNOWN", "publication outcome must be recovered before retrying");
      }
      throw error;
    } finally {
      if (timer) clearInterval(timer);
      await renewal;
      await this.release(request.scope, token).catch(() => {});
    }
  }

  async archive(scope: SkillPublicationScope, expected: SkillPublicationPointer, archiveRows: () => Promise<void>, previousHead?: Skill): Promise<void> {
    await this.changeStatus(scope, expected, "archived", async () => { await archiveRows(); return 0; }, previousHead);
  }

  async remove(scope: SkillPublicationScope, expected: SkillPublicationPointer | null, removeRows: () => Promise<number>, previousHead?: Skill): Promise<number> {
    return this.changeStatus(scope, expected, "deleted", removeRows, previousHead);
  }

  private async changeStatus(scope: SkillPublicationScope, expected: SkillPublicationPointer | null, status: "archived" | "deleted", changeRows: () => Promise<number>, previousHead?: Skill): Promise<number> {
    let head = await this.readHead(scope);
    if (!head) {
      if (!previousHead || !expected) throw failure("SKILL_NOT_FOUND", "status change requires a published legacy identity");
      const previous = checkedSkill(previousHead, scope);
      if (!previous.owner_agent_id || previous.row_id !== expected.row_id || previous.version !== expected.version) throw failure("SKILL_MUTATION_CONFLICT", "legacy status identity does not match its head");
      await this.state.create(this.headKey(scope), { kind: "head", scope, name: previous.name, owner_agent_id: previous.owner_agent_id, pointer: expected, deleted: false, fence: 0, lease: null } satisfies Head);
      head = await this.readHead(scope);
    }
    if (!head) throw failure("SKILL_PUBLICATION_UNKNOWN", "head bootstrap failed");
    if (head.value.deleted && status !== "deleted") throw failure("SKILL_NOT_FOUND", "a deletion tombstone cannot be archived or revived");
    if (head.value.lease && head.value.lease.expires_at > this.now()) throw failure("SKILL_PUBLICATION_BUSY", "skill has a pending publication");
    if (!head.value.deleted && (head.value.pointer?.row_id ?? null) !== (expected?.row_id ?? null)) throw failure("SKILL_VERSION_STALE", "status change expected a different head");
    await this.settleHead(head.value);
    const token = randomUUID();
    const next: Head = { ...head.value, fence: head.value.fence + 1,
      pointer: status === "deleted" ? null : head.value.pointer ? { ...head.value.pointer, status: "archived" } : null,
      deleted: status === "deleted", cleanup_pending: true,
      lease: { token, mutation_id: `status:${status}`, expires_at: this.now() + this.leaseMs } };
    if (!await this.state.compareAndSet(this.headKey(scope), head.revision, next)) throw failure("SKILL_VERSION_STALE", "head changed during status update");
    try {
      const count = await changeRows();
      const current = await this.readHead(scope);
      if (current?.value.lease?.token === token) {
        await this.state.compareAndSet(this.headKey(scope), current.revision, { ...current.value, cleanup_pending: false, lease: null });
      }
      return count;
    } finally {
      await this.release(scope, token).catch(() => {});
    }
  }

  private async acquire(request: SkillPublicationRequest, token: string): Promise<void> {
    const previous = request.previous_head;
    await this.state.create(this.headKey(request.scope), { kind: "head", scope: request.scope, name: request.name, owner_agent_id: request.owner_agent_id,
      pointer: previous ? { row_id: previous.row_id, version: previous.version, mutation_id: previous.mutation_id ?? `legacy:${previous.row_id}`, status: previous.status } : null,
      deleted: false, fence: 0, lease: null } satisfies Head);
    for (let attempt = 0; attempt < 16; attempt++) {
      const head = await this.readHead(request.scope);
      if (!head) throw failure("SKILL_PUBLICATION_UNKNOWN", "publication head disappeared");
      await this.settleHead(head.value);
      if (head.value.deleted) throw failure("SKILL_NOT_FOUND", "a deleted skill cannot be revived by a delayed writer");
      if (head.value.pointer?.status === "archived") throw failure("SKILL_VERSION_STALE", "head is archived");
      if (request.expected_version !== undefined && request.expected_version !== (head.value.pointer?.version ?? 0)) throw failure("SKILL_VERSION_STALE", "head advanced before publication");
      if (head.value.name && (head.value.name !== request.name || head.value.owner_agent_id !== request.owner_agent_id)) throw failure("SKILL_MUTATION_CONFLICT", "publication cannot change the identity or name of a skill");
      if (head.value.lease && head.value.lease.expires_at > this.now()) throw failure("SKILL_PUBLICATION_BUSY", "another writer is preparing this skill");
      const next: Head = { ...head.value, name: request.name, owner_agent_id: request.owner_agent_id, fence: head.value.fence + 1,
        lease: { token, mutation_id: request.mutation_id, expires_at: this.now() + this.leaseMs } };
      if (await this.state.compareAndSet(this.headKey(request.scope), head.revision, next)) {
        try { await this.claimName(request); } catch (error) { await this.release(request.scope, token); throw error; }
        return;
      }
    }
    throw failure("SKILL_PUBLICATION_BUSY", "publication head remained contended");
  }

  private async claimName(request: SkillPublicationRequest): Promise<void> {
    const key = this.nameKey(request);
    const desired = { kind: "name", scope: request.scope };
    if (await this.state.create(key, desired)) return;
    const existing = await this.state.read(key);
    const name = z.object({ kind: z.literal("name"), scope: z.object({ team_id: z.string(), skill_id: z.string() }) }).parse(existing?.value);
    if (sameScope(name.scope, request.scope)) return;
    const other = await this.readHead(name.scope);
    if (!other || (other.value.pointer && other.value.pointer.status !== "archived" && !other.value.deleted) ||
        (other.value.lease && other.value.lease.expires_at > this.now())) throw failure("SKILL_NAME_DUPLICATE", "skill name belongs to another publication");
    // Fence the previous name holder before transferring a failed/retired claim.
    const transfer = randomUUID();
    if (!await this.state.compareAndSet(this.headKey(name.scope), other.revision, { ...other.value, fence: other.value.fence + 1,
      lease: { token: transfer, mutation_id: "name-transfer", expires_at: this.now() + this.leaseMs } })) throw failure("SKILL_NAME_DUPLICATE", "name holder changed");
    try {
      if (!existing || !await this.state.compareAndSet(key, existing.revision, desired)) throw failure("SKILL_NAME_DUPLICATE", "name claim changed");
    } finally { await this.release(name.scope, transfer).catch(() => {}); }
  }

  private async assertNameOwner(request: SkillPublicationRequest): Promise<void> {
    const entry = await this.state.read(this.nameKey(request));
    const scope = (entry?.value as { scope?: SkillPublicationScope } | undefined)?.scope;
    if (!scope || !sameScope(scope, request.scope)) throw failure("SKILL_NAME_DUPLICATE", "skill name claim changed before commit");
  }

  private async ownedHead(scope: SkillPublicationScope, token: string) {
    const head = await this.readHead(scope);
    if (!head || head.value.deleted || head.value.lease?.token !== token || head.value.lease.expires_at <= this.now()) throw failure("SKILL_VERSION_STALE", "publication lease is no longer valid");
    return head;
  }

  private async renew(scope: SkillPublicationScope, token: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await this.ownedHead(scope, token);
      if (await this.state.compareAndSet(this.headKey(scope), head.revision, { ...head.value, lease: { ...head.value.lease!, expires_at: this.now() + this.leaseMs } })) return;
    }
    throw failure("SKILL_VERSION_STALE", "lease renewal remained contended");
  }

  private async invalidate(scope: SkillPublicationScope, token: string, mutationId: string): Promise<SkillPublicationLookup> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const head = await this.readHead(scope);
      if (head?.value.receipt?.mutation_id === mutationId) {
        return this.persistReceipt(scope, head.value.receipt);
      }
      // A subsequent head can only replace this receipt after settleHead persisted it.
      const intent = await this.readIntent(scope, mutationId);
      if (intent?.value.phase === "committed") return this.receipt(intent.value);
      if (!head || head.value.lease?.token !== token) return { status: "absent" };
      if (await this.state.compareAndSet(this.headKey(scope), head.revision, { ...head.value, lease: null, fence: head.value.fence + 1 })) return { status: "absent" };
    }
    return { status: "unknown" };
  }

  private async release(scope: SkillPublicationScope, token: string): Promise<void> {
    const head = await this.readHead(scope);
    if (head?.value.lease?.token === token) {
      await this.settleHead(head.value);
      await this.state.compareAndSet(this.headKey(scope), head.revision, { ...head.value, lease: null });
    }
  }

  private async ensureIntent(request: SkillPublicationRequest): Promise<void> {
    const value: Intent = { kind: "intent", scope: request.scope, mutation_id: request.mutation_id, payload_hash: request.payload_hash, phase: "preparing" };
    await this.state.create(this.intentKey(request.scope, request.mutation_id), value);
    const current = await this.readIntent(request.scope, request.mutation_id);
    if (!current || current.value.payload_hash !== request.payload_hash) throw failure("SKILL_MUTATION_CONFLICT", "mutation id was reused with different input");
  }

  private async setIntent(request: SkillPublicationRequest, token: string, phase: "preparing" | "committing", skill?: Skill): Promise<void> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const owned = await this.ownedHead(request.scope, token);
      const current = await this.readIntent(request.scope, request.mutation_id);
      if (!current || current.value.payload_hash !== request.payload_hash || current.value.phase === "committed") throw failure("SKILL_MUTATION_CONFLICT", "intent changed before preparation");
      // A head check and an intent CAS are different documents. Remember the
      // head fence so a delayed old writer cannot overwrite a newer prepared skill.
      if (current.value.fence !== undefined && (current.value.fence > owned.value.fence ||
          (current.value.fence === owned.value.fence && current.value.token !== token))) {
        throw failure("SKILL_VERSION_STALE", "intent belongs to a newer publication lease");
      }
      if (await this.state.compareAndSet(this.intentKey(request.scope, request.mutation_id), current.revision, {
        ...current.value, phase, token, fence: owned.value.fence, ...(skill ? { skill } : {}),
      })) return;
    }
    throw failure("SKILL_PUBLICATION_BUSY", "intent remained contended");
  }

  private async persistReceipt(scope: SkillPublicationScope, reference: Receipt): Promise<Extract<SkillPublicationLookup, { status: "committed" }>> {
    const key = this.intentKey(scope, reference.mutation_id);
    for (let attempt = 0; attempt < 16; attempt++) {
      const current = await this.readIntent(scope, reference.mutation_id);
      // The head proves publication; the intent supplies the already-persisted
      // bytes. Neither a prepared intent alone nor an unmatched reference proves a commit.
      if (!current || (current.value.phase !== "committing" && current.value.phase !== "committed")) {
        throw failure("SKILL_PUBLICATION_UNKNOWN", "head receipt has no prepared intent");
      }
      let skill: Skill;
      try { skill = checkedSkill(current.value.skill, scope); }
      catch { throw failure("SKILL_PUBLICATION_UNKNOWN", "head receipt has an invalid prepared skill"); }
      if (current.value.payload_hash !== reference.payload_hash || skill.row_id !== reference.row_id || skill.version !== reference.version ||
          (skill.mutation_id !== undefined && skill.mutation_id !== reference.mutation_id) ||
          (skill.mutation_payload_hash !== undefined && skill.mutation_payload_hash !== reference.payload_hash)) {
        throw failure("SKILL_PUBLICATION_UNKNOWN", "head receipt does not match the prepared intent");
      }
      const result = { status: "committed" as const, skill, payload_hash: reference.payload_hash };
      if (current.value.phase === "committed") return result;
      const value: Intent = { ...current.value, phase: "committed", skill };
      if (await this.state.compareAndSet(key, current.revision, value)) return result;
    }
    throw failure("SKILL_PUBLICATION_UNKNOWN", "committed receipt could not be persisted");
  }

  private async failIntent(scope: SkillPublicationScope, mutationId: string, token?: string): Promise<void> {
    const current = await this.readIntent(scope, mutationId);
    if (current && current.value.phase !== "committed" && (!current.value.token || current.value.token === token)) {
      await this.state.compareAndSet(this.intentKey(scope, mutationId), current.revision, { ...current.value, phase: "failed" });
    }
  }

  private async settleHead(head: Head): Promise<void> { if (head.receipt) await this.persistReceipt(head.scope, head.receipt); }
  private receipt(intent: Intent): Extract<SkillPublicationLookup, { status: "committed" }> {
    return { status: "committed", skill: checkedSkill(intent.skill, intent.scope), payload_hash: intent.payload_hash };
  }
  private matchReplay(request: SkillPublicationRequest, receipt: Extract<SkillPublicationLookup, { status: "committed" }>): Skill {
    if (receipt.payload_hash !== request.payload_hash) throw failure("SKILL_MUTATION_CONFLICT", "mutation id was reused with a different payload");
    return receipt.skill;
  }
  private async readHead(scope: SkillPublicationScope) {
    return this.parseHead(scope, await this.state.read(this.headKey(scope)));
  }
  private parseHead(scope: SkillPublicationScope, row: SkillStateRecord | null) {
    if (!row) return null;
    const parsed = headSchema.safeParse(row.value);
    if (!parsed.success || !sameScope(parsed.data.scope, scope)) throw failure("SKILL_PUBLICATION_UNKNOWN", "invalid publication head record");
    return { revision: row.revision, value: parsed.data };
  }
  private async readIntent(scope: SkillPublicationScope, mutationId: string) {
    const row = await this.state.read(this.intentKey(scope, mutationId));
    if (!row) return null;
    const parsed = intentSchema.safeParse(row.value);
    if (!parsed.success || !sameScope(parsed.data.scope, scope) || parsed.data.mutation_id !== mutationId) throw failure("SKILL_PUBLICATION_UNKNOWN", "invalid publication intent record");
    return { revision: row.revision, value: parsed.data };
  }
  private validateRequest(request: SkillPublicationRequest): void {
    if (!request.scope.team_id || !request.scope.skill_id || !request.mutation_id.trim() || !request.payload_hash || !request.name || !request.owner_agent_id ||
        (request.expected_version !== undefined && (!Number.isSafeInteger(request.expected_version) || request.expected_version < 0))) throw failure("SKILL_MUTATION_CONFLICT", "invalid publication intent");
    if (request.previous_head) checkedSkill(request.previous_head, request.scope);
  }
  private deletionIndexKey(skillId: string) { return `${this.prefix}deletion-index/${hash(skillId)}`; }
  private deletionKey(scope: SkillPublicationScope) { return `${this.prefix}deletion/${hash([scope.team_id, scope.skill_id])}`; }
  private headKey(scope: SkillPublicationScope) { return `${this.prefix}head/${hash([scope.team_id, scope.skill_id])}`; }
  private intentKey(scope: SkillPublicationScope, id: string) { return `${this.prefix}intent/${hash([scope.team_id, scope.skill_id, id])}`; }
  private nameKey(request: SkillPublicationRequest) { return `${this.prefix}name/${hash([request.scope.team_id, request.owner_agent_id, request.name])}`; }
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sameScope(a: SkillPublicationScope, b: SkillPublicationScope): boolean { return a.team_id === b.team_id && a.skill_id === b.skill_id; }
function failure(code: string, message: string): SkillPublicationError { return new SkillPublicationError(code, message); }
function checkedSkill(value: unknown, scope: SkillPublicationScope): Skill {
  const row = value as Skill | undefined;
  if (!row || typeof row !== "object" || !sameScope(row, scope) || typeof row.row_id !== "string" || !row.row_id ||
      !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.content !== "string" || typeof row.storage_dir !== "string" ||
      !Array.isArray(row.manifest) || typeof row.name !== "string" || typeof row.owner_agent_id !== "string") throw failure("SKILL_MUTATION_CONFLICT", "invalid prepared skill receipt");
  const normalized = { ...row, manifest: row.manifest.map(entry => {
    const copy = { ...entry };
    if (copy.content_sha256 === undefined) delete copy.content_sha256;
    return copy;
  }) };
  for (const key of ["mutation_id", "mutation_payload_hash", "mutation_request_hash"] as const) {
    if (normalized[key] === undefined) delete normalized[key];
  }
  return normalized;
}
