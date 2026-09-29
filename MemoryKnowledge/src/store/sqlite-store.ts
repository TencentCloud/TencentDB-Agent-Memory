/**
 * SqliteKnowledgeStore — SQLite/Drizzle implementation of IKnowledgeStore.
 *
 * Responsibilities:
 *   - code-graph / wiki asset CRUD (hard delete; soft-delete markers via deleted_at)
 *   - Multi-tenant isolation (001, phase 5): EVERY read/write is scoped by
 *     `service_id` (first parameter), then `team_id` where applicable. id-only
 *     accessors also filter service_id so a foreign tenant can never read/mutate
 *     another tenant's row (returns null/false → 404).
 *   - Global ID generation (wiki-/cg-) + idempotency: same
 *     (service_id, team_id, repo_url, branch) or (service_id, team_id, name)
 *     duplicate create returns existing.
 *   - Status state machine + restart recovery.
 */

import { eq, and, isNull, desc, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  knowledgeCodeGraph,
  knowledgeWiki,
  knowledgeWikiAudit,
  knowledgeCodeGraphAudit,
  CODE_DATA_VERSION,
  WIKI_DATA_VERSION,
} from "../db/schema.js";
import { genCodeGraphId, genWikiId } from "./ids.js";
import type {
  IKnowledgeStore,
  SyncStatus,
  CodeGraphRow,
  CreateCodeGraphInput,
  CodeGraphStatusPatch,
  CodeGraphMetaPatch,
  WikiRow,
  CreateWikiInput,
  WikiStatusPatch,
  WikiMetaPatch,
  AuditLogInput,
  AuditLogRow,
  CreateResult,
  ListOpts,
  CountOpts,
  SyncedCodeGraphRef,
  SyncedWikiRef,
} from "./types.js";

const ID_RETRY = 5;

function nowIso(): string {
  return new Date().toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

// ───────────────────────── Store ─────────────────────────

export class SqliteKnowledgeStore implements IKnowledgeStore {
  constructor(private readonly db: Db) {}

  // ═══════════════════════ Code-Graph ═══════════════════════

  /**
   * Idempotent create: hit (service_id, team_id, repo_url, branch) returns existing
   * (existed=true); otherwise generate cg- id and insert (PK conflict auto-retry).
   */
  createCodeGraph(input: CreateCodeGraphInput): CreateResult<CodeGraphRow> {
    const existing = this.db
      .select()
      .from(knowledgeCodeGraph)
      .where(
        and(
          eq(knowledgeCodeGraph.serviceId, input.service_id),
          eq(knowledgeCodeGraph.teamId, input.team_id),
          eq(knowledgeCodeGraph.repoUrl, input.repo_url),
          eq(knowledgeCodeGraph.branch, input.branch),
          isNull(knowledgeCodeGraph.deletedAt),
        ),
      )
      .get();
    if (existing) return { row: this.mapCgRow(existing), existed: true };

    const ts = nowIso();
    for (let attempt = 0; attempt < ID_RETRY; attempt++) {
      const id = genCodeGraphId();
      try {
        this.db
          .insert(knowledgeCodeGraph)
          .values({
            codeGraphId: id,
            serviceId: input.service_id,
            teamId: input.team_id,
            repoName: input.repo_name ?? "",
            repoUrl: input.repo_url,
            branch: input.branch,
            sparsePaths: input.sparse_paths?.length ? JSON.stringify(input.sparse_paths) : null,
            ownerUserId: input.owner_user_id ?? null,
            userId: input.user_id ?? null,
            agentId: input.agent_id ?? null,
            taskId: input.task_id ?? null,
            visibility: input.visibility ?? "team",
            status: "pending",
            serviceUrl: input.service_url ?? null,
            version: CODE_DATA_VERSION,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();

        const row = this.db
          .select()
          .from(knowledgeCodeGraph)
          .where(eq(knowledgeCodeGraph.codeGraphId, id))
          .get();
        return { row: this.mapCgRow(row!), existed: false };
      } catch (err) {
        // PK conflict → retry with new id; unique(memory,team,repo,branch) conflict → race, return existing
        const raced = this.db
          .select()
          .from(knowledgeCodeGraph)
          .where(
            and(
              eq(knowledgeCodeGraph.serviceId, input.service_id),
              eq(knowledgeCodeGraph.teamId, input.team_id),
              eq(knowledgeCodeGraph.repoUrl, input.repo_url),
              eq(knowledgeCodeGraph.branch, input.branch),
              isNull(knowledgeCodeGraph.deletedAt),
            ),
          )
          .get();
        if (raced) return { row: this.mapCgRow(raced), existed: true };
        if (!isUniqueViolation(err) || attempt === ID_RETRY - 1) throw err;
      }
    }
    throw new Error("createCodeGraph: failed to allocate unique id");
  }

  getCodeGraph(serviceId: string, teamId: string, codeGraphId: string): CodeGraphRow | null {
    const row = this.db
      .select()
      .from(knowledgeCodeGraph)
      .where(
        and(
          eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraph.serviceId, serviceId),
          eq(knowledgeCodeGraph.teamId, teamId),
        ),
      )
      .get();
    return row ? this.mapCgRow(row) : null;
  }

  /** id-only accessor — STILL scoped by service_id (cross-Memory leak guard, 001 §2.4). */
  getCodeGraphById(serviceId: string, codeGraphId: string): CodeGraphRow | null {
    const row = this.db
      .select()
      .from(knowledgeCodeGraph)
      .where(
        and(
          eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraph.serviceId, serviceId),
        ),
      )
      .get();
    return row ? this.mapCgRow(row) : null;
  }

  listCodeGraphs(serviceId: string, teamId: string, opts?: ListOpts): CodeGraphRow[] {
    const conditions: SQL[] = [
      eq(knowledgeCodeGraph.serviceId, serviceId),
      eq(knowledgeCodeGraph.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(knowledgeCodeGraph.status, opts.syncStatus));
    }
    const rows = this.db
      .select()
      .from(knowledgeCodeGraph)
      .where(and(...conditions))
      .orderBy(desc(knowledgeCodeGraph.updatedAt))
      .limit(opts?.limit ?? 20)
      .offset(opts?.offset ?? 0)
      .all();
    return rows.map((r) => this.mapCgRow(r));
  }

  countCodeGraphs(serviceId: string, teamId: string, opts?: CountOpts): number {
    const conditions: SQL[] = [
      eq(knowledgeCodeGraph.serviceId, serviceId),
      eq(knowledgeCodeGraph.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(knowledgeCodeGraph.status, opts.syncStatus));
    }
    const result = this.db
      .select({ total: sql<number>`count(*)` })
      .from(knowledgeCodeGraph)
      .where(and(...conditions))
      .get();
    return result?.total ?? 0;
  }

  /** id-only mutation — scoped by service_id so a foreign tenant cannot mutate. */
  updateCodeGraphStatus(serviceId: string, codeGraphId: string, patch: CodeGraphStatusPatch): void {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.internal_status !== undefined) set.internalStatus = patch.internal_status;
    if (patch.sync_error !== undefined) set.syncError = patch.sync_error;
    if (patch.commit_hash !== undefined) set.commitHash = patch.commit_hash;
    if (patch.stats_json !== undefined) set.statsJson = patch.stats_json;
    if (patch.last_sync_at !== undefined) set.lastSyncAt = patch.last_sync_at;
    if (patch.service_url !== undefined) set.serviceUrl = patch.service_url;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.version !== undefined) set.version = patch.version;

    this.db
      .update(knowledgeCodeGraph)
      .set(set)
      .where(
        and(
          eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraph.serviceId, serviceId),
        ),
      )
      .run();
  }

  /** Hard delete; memory/team mismatch returns false. */
  deleteCodeGraph(serviceId: string, teamId: string, codeGraphId: string): boolean {
    const result = this.db
      .delete(knowledgeCodeGraph)
      .where(
        and(
          eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraph.serviceId, serviceId),
          eq(knowledgeCodeGraph.teamId, teamId),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /** Update code-graph metadata (repo_name, summary). memory mismatch → null. */
  updateCodeGraphMeta(serviceId: string, codeGraphId: string, patch: CodeGraphMetaPatch): CodeGraphRow | null {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.repo_name !== undefined) set.repoName = patch.repo_name;
    if (patch.summary !== undefined) set.summary = patch.summary;
    this.db
      .update(knowledgeCodeGraph)
      .set(set)
      .where(
        and(
          eq(knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraph.serviceId, serviceId),
        ),
      )
      .run();
    return this.getCodeGraphById(serviceId, codeGraphId);
  }

  // ═══════════════════════ Wiki ═══════════════════════

  createWiki(input: CreateWikiInput): CreateResult<WikiRow> {
    const existing = this.db
      .select()
      .from(knowledgeWiki)
      .where(
        and(
          eq(knowledgeWiki.serviceId, input.service_id),
          eq(knowledgeWiki.teamId, input.team_id),
          eq(knowledgeWiki.name, input.name),
          isNull(knowledgeWiki.deletedAt),
        ),
      )
      .get();
    if (existing) return { row: this.mapWikiRow(existing), existed: true };

    const ts = nowIso();
    for (let attempt = 0; attempt < ID_RETRY; attempt++) {
      const id = genWikiId();
      try {
        this.db
          .insert(knowledgeWiki)
          .values({
            wikiId: id,
            serviceId: input.service_id,
            teamId: input.team_id,
            name: input.name,
            sourceType: input.source_type ?? null,
            sourceUrl: input.source_url ?? null,
            ownerUserId: input.owner_user_id ?? null,
            userId: input.user_id ?? null,
            agentId: input.agent_id ?? null,
            taskId: input.task_id ?? null,
            visibility: input.visibility ?? "team",
            status: "draft",
            serviceUrl: input.service_url ?? null,
            version: WIKI_DATA_VERSION,
            createdAt: ts,
            updatedAt: ts,
          })
          .run();

        const row = this.db
          .select()
          .from(knowledgeWiki)
          .where(eq(knowledgeWiki.wikiId, id))
          .get();
        return { row: this.mapWikiRow(row!), existed: false };
      } catch (err) {
        const raced = this.db
          .select()
          .from(knowledgeWiki)
          .where(
            and(
              eq(knowledgeWiki.serviceId, input.service_id),
              eq(knowledgeWiki.teamId, input.team_id),
              eq(knowledgeWiki.name, input.name),
              isNull(knowledgeWiki.deletedAt),
            ),
          )
          .get();
        if (raced) return { row: this.mapWikiRow(raced), existed: true };
        if (!isUniqueViolation(err) || attempt === ID_RETRY - 1) throw err;
      }
    }
    throw new Error("createWiki: failed to allocate unique id");
  }

  getWiki(serviceId: string, teamId: string, wikiId: string): WikiRow | null {
    const row = this.db
      .select()
      .from(knowledgeWiki)
      .where(
        and(
          eq(knowledgeWiki.wikiId, wikiId),
          eq(knowledgeWiki.serviceId, serviceId),
          eq(knowledgeWiki.teamId, teamId),
        ),
      )
      .get();
    return row ? this.mapWikiRow(row) : null;
  }

  /** id-only accessor — STILL scoped by service_id (cross-Memory leak guard, 001 §2.4). */
  getWikiById(serviceId: string, wikiId: string): WikiRow | null {
    const row = this.db
      .select()
      .from(knowledgeWiki)
      .where(
        and(
          eq(knowledgeWiki.wikiId, wikiId),
          eq(knowledgeWiki.serviceId, serviceId),
        ),
      )
      .get();
    return row ? this.mapWikiRow(row) : null;
  }

  listWikis(serviceId: string, teamId: string, opts?: ListOpts): WikiRow[] {
    const conditions: SQL[] = [
      eq(knowledgeWiki.serviceId, serviceId),
      eq(knowledgeWiki.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(knowledgeWiki.status, opts.syncStatus));
    }
    const rows = this.db
      .select()
      .from(knowledgeWiki)
      .where(and(...conditions))
      .orderBy(desc(knowledgeWiki.updatedAt))
      .limit(opts?.limit ?? 20)
      .offset(opts?.offset ?? 0)
      .all();
    return rows.map((r) => this.mapWikiRow(r));
  }

  countWikis(serviceId: string, teamId: string, opts?: CountOpts): number {
    const conditions: SQL[] = [
      eq(knowledgeWiki.serviceId, serviceId),
      eq(knowledgeWiki.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(knowledgeWiki.status, opts.syncStatus));
    }
    const result = this.db
      .select({ total: sql<number>`count(*)` })
      .from(knowledgeWiki)
      .where(and(...conditions))
      .get();
    return result?.total ?? 0;
  }

  /** id-only mutation — scoped by service_id so a foreign tenant cannot mutate. */
  updateWikiStatus(serviceId: string, wikiId: string, patch: WikiStatusPatch): void {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.internal_status !== undefined) set.internalStatus = patch.internal_status;
    if (patch.sync_error !== undefined) set.syncError = patch.sync_error;
    if (patch.page_count !== undefined) set.pageCount = patch.page_count;
    if (patch.last_sync_at !== undefined) set.lastSyncAt = patch.last_sync_at;
    if (patch.service_url !== undefined) set.serviceUrl = patch.service_url;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.version !== undefined) set.version = patch.version;

    this.db
      .update(knowledgeWiki)
      .set(set)
      .where(
        and(
          eq(knowledgeWiki.wikiId, wikiId),
          eq(knowledgeWiki.serviceId, serviceId),
        ),
      )
      .run();
  }

  deleteWiki(serviceId: string, teamId: string, wikiId: string): boolean {
    const result = this.db
      .delete(knowledgeWiki)
      .where(
        and(
          eq(knowledgeWiki.wikiId, wikiId),
          eq(knowledgeWiki.serviceId, serviceId),
          eq(knowledgeWiki.teamId, teamId),
        ),
      )
      .run();
    return result.changes > 0;
  }

  /** Update wiki metadata (name, summary). memory mismatch → null. */
  updateWikiMeta(serviceId: string, wikiId: string, patch: WikiMetaPatch): WikiRow | null {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.summary !== undefined) set.summary = patch.summary;
    this.db
      .update(knowledgeWiki)
      .set(set)
      .where(
        and(
          eq(knowledgeWiki.wikiId, wikiId),
          eq(knowledgeWiki.serviceId, serviceId),
        ),
      )
      .run();
    return this.getWikiById(serviceId, wikiId);
  }

  // ═══════════════════════ Audit ═══════════════════════

  appendWikiAudit(input: AuditLogInput): void {
    this.db
      .insert(knowledgeWikiAudit)
      .values({
        wikiId: input.asset_id,
        serviceId: input.service_id ?? null,
        version: input.version,
        action: input.action,
        userId: input.user_id ?? null,
        agentId: input.agent_id ?? null,
        detail: input.detail ?? null,
        createdAt: nowIso(),
      })
      .run();
  }

  appendCodeGraphAudit(input: AuditLogInput): void {
    this.db
      .insert(knowledgeCodeGraphAudit)
      .values({
        codeGraphId: input.asset_id,
        serviceId: input.service_id ?? null,
        version: input.version,
        action: input.action,
        userId: input.user_id ?? null,
        agentId: input.agent_id ?? null,
        detail: input.detail ?? null,
        createdAt: nowIso(),
      })
      .run();
  }

  listWikiAudit(serviceId: string, wikiId: string, limit = 20, offset = 0): AuditLogRow[] {
    const rows = this.db
      .select()
      .from(knowledgeWikiAudit)
      .where(
        and(
          eq(knowledgeWikiAudit.wikiId, wikiId),
          eq(knowledgeWikiAudit.serviceId, serviceId),
        ),
      )
      .orderBy(desc(knowledgeWikiAudit.version), desc(knowledgeWikiAudit.id))
      .limit(limit)
      .offset(offset)
      .all();
    return rows.map((r) => ({
      id: r.id,
      service_id: r.serviceId ?? null,
      asset_id: r.wikiId,
      version: r.version,
      action: r.action as AuditLogRow["action"],
      user_id: r.userId,
      agent_id: r.agentId,
      detail: r.detail,
      created_at: r.createdAt,
    }));
  }

  listCodeGraphAudit(serviceId: string, codeGraphId: string, limit = 20, offset = 0): AuditLogRow[] {
    const rows = this.db
      .select()
      .from(knowledgeCodeGraphAudit)
      .where(
        and(
          eq(knowledgeCodeGraphAudit.codeGraphId, codeGraphId),
          eq(knowledgeCodeGraphAudit.serviceId, serviceId),
        ),
      )
      .orderBy(desc(knowledgeCodeGraphAudit.version), desc(knowledgeCodeGraphAudit.id))
      .limit(limit)
      .offset(offset)
      .all();
    return rows.map((r) => ({
      id: r.id,
      service_id: r.serviceId ?? null,
      asset_id: r.codeGraphId,
      version: r.version,
      action: r.action as AuditLogRow["action"],
      user_id: r.userId,
      agent_id: r.agentId,
      detail: r.detail,
      created_at: r.createdAt,
    }));
  }

  // ═══════════════════════ Restart Recovery ═══════════════════════

  /**
   * Sweep all non-terminal (pending/processing) assets to failed, across all tenants.
   * After restart, in-memory SerialQueue tasks are lost; this makes them visible to control plane.
   * @returns total affected rows (code + wiki combined).
   */
  markInterruptedAsFailed(reason = "interrupted by restart"): number {
    const ts = nowIso();
    const a = this.db
      .update(knowledgeCodeGraph)
      .set({ status: "failed", syncError: reason, updatedAt: ts })
      .where(sql`status IN ('pending','processing')`)
      .run();
    const b = this.db
      .update(knowledgeWiki)
      .set({ status: "failed", syncError: reason, updatedAt: ts })
      .where(sql`status IN ('pending','processing')`)
      .run();
    return a.changes + b.changes;
  }

  /** All ready code-graphs (with service_id) so module.ts can rebuild per-tenant dirs. */
  listSyncedCodeGraphs(): SyncedCodeGraphRef[] {
    return this.db
      .select({
        code_graph_id: knowledgeCodeGraph.codeGraphId,
        service_id: knowledgeCodeGraph.serviceId,
        team_id: knowledgeCodeGraph.teamId,
      })
      .from(knowledgeCodeGraph)
      .where(
        and(
          eq(knowledgeCodeGraph.status, "ready"),
          isNull(knowledgeCodeGraph.deletedAt),
        ),
      )
      .all();
  }

  listSyncedWikis(): SyncedWikiRef[] {
    return this.db
      .select({
        wiki_id: knowledgeWiki.wikiId,
        service_id: knowledgeWiki.serviceId,
        team_id: knowledgeWiki.teamId,
      })
      .from(knowledgeWiki)
      .where(
        and(eq(knowledgeWiki.status, "ready"), isNull(knowledgeWiki.deletedAt)),
      )
      .all();
  }

  // ═══════════════════════ Mappers ═══════════════════════

  private mapCgRow(r: typeof knowledgeCodeGraph.$inferSelect): CodeGraphRow {
    let sparsePaths: string[] = [];
    if (r.sparsePaths) {
      try {
        const parsed = JSON.parse(r.sparsePaths);
        if (Array.isArray(parsed) && parsed.every((path): path is string => typeof path === "string")) {
          sparsePaths = parsed;
        }
      } catch {
        // malformed legacy metadata falls back to full checkout
      }
    }
    return {
      code_graph_id: r.codeGraphId,
      service_id: r.serviceId,
      team_id: r.teamId,
      repo_name: r.repoName,
      repo_url: r.repoUrl,
      branch: r.branch,
      sparse_paths: sparsePaths,
      commit_hash: r.commitHash,
      owner_user_id: r.ownerUserId,
      user_id: r.userId,
      agent_id: r.agentId,
      task_id: r.taskId,
      visibility: r.visibility,
      status: r.status as SyncStatus,
      internal_status: r.internalStatus,
      sync_error: r.syncError,
      stats_json: r.statsJson,
      service_url: r.serviceUrl ?? null,
      summary: r.summary ?? null,
      version: r.version,
      last_sync_at: r.lastSyncAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      deleted_at: r.deletedAt ?? null,
    };
  }

  private mapWikiRow(r: typeof knowledgeWiki.$inferSelect): WikiRow {
    return {
      wiki_id: r.wikiId,
      service_id: r.serviceId,
      team_id: r.teamId,
      name: r.name,
      source_type: r.sourceType,
      source_url: r.sourceUrl,
      owner_user_id: r.ownerUserId,
      user_id: r.userId,
      agent_id: r.agentId,
      task_id: r.taskId,
      visibility: r.visibility,
      status: r.status as SyncStatus,
      internal_status: r.internalStatus,
      sync_error: r.syncError,
      page_count: r.pageCount,
      service_url: r.serviceUrl ?? null,
      summary: r.summary ?? null,
      version: r.version,
      last_sync_at: r.lastSyncAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      deleted_at: r.deletedAt ?? null,
    };
  }
}
