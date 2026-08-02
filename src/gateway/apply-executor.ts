/**
 * ApplyExecutor — POST /memory/apply (wave tdai-memory-subagents-2026-08-02, P4).
 *
 * Applies a memory-keeper diff.json through the gateway, keeping records and
 * vectors consistent (ТЗ §5.5). SRP: the P6 orchestrator owns sequencing /
 * spawn / reporting; this module owns manifest recheck + backup + abort loop +
 * syncSceneIndex, so the atomicity contract is unit-testable in isolation.
 *
 * Contract (also documented in docs/specs/.../packets/B2.md):
 *
 *   POST /memory/apply   (Content-Type: application/json; write-gate: Bearer
 *                         apiKey OR x-memory-token — see write-auth.ts)
 *   {
 *     "diff": {
 *       "deleteL1":     [{"id": "m_1", "updatedAt": "2026-08-02T10:00:00Z"}],
 *       "merge":        [{"cluster": ["m_1","m_2"], "target": "m_1", "content": "merged"}],
 *       "rewriteBlock": [{"path": "scene_blocks/_global/ok.md", "content": "<META…>"}],
 *       "rewritePersona": "persona body"
 *     },
 *     "manifest": { "baseline": { "scene_blocks/_global/ok.md": "<sha256hex>", "persona.md": "<sha256hex>" } },
 *     "context":  { "presentedRecordIds": ["m_1","m_2"] }
 *   }
 *
 * Guarantees:
 * - zod ^4.4.3 z.strictObject() validation + semantic guardrails; safeParse
 *   with readable errors (z.treeifyError / z.prettifyError). Invalid input
 *   aborts BEFORE any mutation — no partial apply (критерий 19c).
 * - Trust-boundary manifest: baseline captured at spawn (scene_blocks/** +
 *   persona.md, sha256), rechecked before apply; drift → abort. Records and
 *   vectors are deliberately NOT in the manifest (the gateway writes them).
 *   Files rewritten by a previous apply run (content already equals the diff
 *   content) are tolerated — that is the heal re-run path, not a drift.
 * - Stale-delete race: the diff carries per-id updatedAt; a target whose
 *   current updated_time differs → abort (fresh data would be lost). A missing
 *   target → already applied → skip (idempotent re-run), NOT an abort.
 * - Mutation order: writes (merge) before deletes, files (scene/persona) after
 *   DB. deleteL1Batch returns boolean and never throws → abort on false;
 *   writeMemory is async and may throw/return null → try/catch, abort.
 * - Partial-apply semantics: an abort on the 2nd+ mutation leaves earlier
 *   mutations applied; the report lists them and the run is idempotent — a
 *   re-run skips already-applied ops (heal).
 * - Post-apply vec-vs-meta count check: both COUNTs + orphan/missing id-sets
 *   in one store transaction; mismatch → orphan purge (per-id stmtDeleteVec)
 *   → reindexAll with a livelock cap (2) → per-row backfill of the delta
 *   (reindexL1Records, ТЗ §5.6 — NOT a third full reindex) + L0 window-skip
 *   heal (reindexL0Records); unresolved → run failed + report.
 * - Scene/persona rewritten atomically (tmp + rename) with a backup in
 *   dataDir/.backup; syncSceneIndex after apply (error → run failed + log;
 *   rebuild happens on the next /memory/validate).
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type http from "node:http";
import { z } from "zod";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { Logger } from "../core/types.js";
import { writeMemory, type ExtractedMemory, type DedupDecision, type MemoryType } from "../core/record/l1-writer.js";
import { parseSceneBlock } from "../core/scene/scene-format.js";
import * as sceneIndex from "../core/scene/scene-index.js";
import { parseJsonBody, sendJson, sendError, openReadonlySqlite } from "./http-utils.js";
import { isSceneBlockRelPathOrPersona } from "./block-paths.js";
import type { GatewayConfig } from "./config.js";
import type { TdaiCore } from "../core/tdai-core.js";

// ============================
// Limits (ТЗ §5.6 mechanical caps)
// ============================

/** Scene block char limit (same constant as memory-routes.ts). */
export const SCENE_LIMIT_CHARS = 1500;
/** Persona char limit (same constant as memory-routes.ts). */
export const PERSONA_LIMIT_CHARS = 2000;
/** Batch caps — upper bounds per diff section (safety nets; the diff the
 * orchestrator presents is already double-capped at ~20 records, §5.4). */
export const MAX_DELETE_L1_OPS = 500;
export const MAX_MERGE_OPS = 100;
export const MAX_REWRITE_OPS = 100;
export const MAX_MERGE_CLUSTER = 50;
export const MAX_PRESENTED_IDS = 5000;
/** Livelock cap for reindexAll retries (ТЗ §5.6). */
export const MAX_REINDEX_RETRIES = 2;

// Real META delimiters from scene-format.ts (rewrite guardrail must check the
// actual markers — a bare "META_START" substring would pass delimiter-less
// content that parseSceneBlock treats as body-only).
const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

// ============================
// Diff schema (zod ^4.4.3, z.strictObject)
// ============================

const deleteL1OpSchema = z.strictObject({
  id: z.string().min(1),
  /** updatedAt observed by the memory-keeper when the diff was built. */
  updatedAt: z.string(),
});

const mergeOpSchema = z.strictObject({
  /** Duplicate cluster member ids (≥ 2). */
  cluster: z.array(z.string().min(1)).min(2).max(MAX_MERGE_CLUSTER),
  /** Surviving member id — must be a member of `cluster` (guardrail). */
  target: z.string().min(1),
  /** Merged content. */
  content: z.string().max(4000),
});

const rewriteBlockOpSchema = z.strictObject({
  /** Path relative to dataDir, e.g. "scene_blocks/_global/ok.md". */
  path: z.string().min(1),
  /** Full file content INCLUDING META frontmatter (validator requires META). */
  content: z.string().max(SCENE_LIMIT_CHARS),
});

const diffSchema = z.strictObject({
  deleteL1: z.array(deleteL1OpSchema).max(MAX_DELETE_L1_OPS).optional(),
  merge: z.array(mergeOpSchema).max(MAX_MERGE_OPS).optional(),
  rewriteBlock: z.array(rewriteBlockOpSchema).max(MAX_REWRITE_OPS).optional(),
  rewritePersona: z.string().max(PERSONA_LIMIT_CHARS).optional(),
});

const applyRequestSchema = z.strictObject({
  diff: diffSchema,
  /** Trust-boundary manifest: baseline path → sha256 hex at spawn. */
  manifest: z.strictObject({
    baseline: z.record(z.string(), z.string()),
  }),
  /** Record ids presented to the memory-keeper (deleteL1 ids must ⊆ this). */
  context: z.strictObject({
    presentedRecordIds: z.array(z.string()).max(MAX_PRESENTED_IDS),
  }),
});

// ============================
// Typed errors
// ============================

/** Invalid diff / guardrail violation — aborted before any mutation. */
export class ApplyValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ApplyValidationError";
  }
}

/** Trust-boundary manifest drift — files changed outside /memory/apply. */
export class ManifestDriftError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ManifestDriftError";
  }
}

/** A delete target was updated since the diff was built — fresh data at risk. */
export class StaleDeleteError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "StaleDeleteError";
  }
}

/** Store/fs runtime failure (deleteL1Batch=false, writeMemory null/throw, …). */
export class ApplyRuntimeError extends Error {
  readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = "ApplyRuntimeError";
  }
}

// ============================
// Result types
// ============================

export interface ApplyCounts {
  metaCount: number | null;
  vecCount: number | null;
  /** null when vec0 tables are absent / the check was skipped. */
  consistent: boolean | null;
}

export interface ApplyResult {
  ok: boolean;
  status: "applied" | "aborted" | "failed";
  /** True when ≥ 1 mutation was applied before an abort (heal re-run needed). */
  partial: boolean;
  /** HTTP status for aborted/failed results (400 validation · 409 drift/stale · 500 runtime). */
  statusCode?: number;
  error?: string;
  applied: { merges: string[]; deletes: string[]; rewrites: string[] };
  skipped: { merges: string[]; deletes: string[]; rewrites: string[] };
  counts: ApplyCounts | null;
  reindexed: boolean;
  needsReindex: boolean;
  sceneIndexSynced: boolean;
}

interface ParsedApplyRequest {
  diff: {
    deleteL1?: Array<{ id: string; updatedAt: string }>;
    merge?: Array<{ cluster: string[]; target: string; content: string }>;
    rewriteBlock?: Array<{ path: string; content: string }>;
    rewritePersona?: string;
  };
  manifest: { baseline: Record<string, string> };
  context: { presentedRecordIds: string[] };
}

/** Row fetched for merge provenance / stale re-check. */
interface MetaRow {
  record_id: string;
  updated_time: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  project_id: string;
  scope: string;
  metadata_json: string;
}

const EMPTY_RESULT = (): ApplyResult => ({
  ok: false,
  status: "aborted",
  partial: false,
  applied: { merges: [], deletes: [], rewrites: [] },
  skipped: { merges: [], deletes: [], rewrites: [] },
  counts: null,
  reindexed: false,
  needsReindex: false,
  sceneIndexSynced: false,
});

// ============================
// ApplyExecutor
// ============================

export interface ApplyExecutorDeps {
  dataDir: string;
  logger: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}

export class ApplyExecutor {
  private readonly deps: ApplyExecutorDeps;

  constructor(deps: ApplyExecutorDeps) {
    this.deps = deps;
  }

  /**
   * Validate + apply a raw request body. Never throws for expected failures —
   * returns an ApplyResult with status applied/aborted/failed and the HTTP
   * statusCode for aborts. Throws only on unexpected internal errors.
   */
  async apply(rawBody: unknown): Promise<ApplyResult> {
    const result = EMPTY_RESULT();
    try {
      // 1. zod validation (strict, readable errors) — before any mutation.
      const parsed = this.parseRequest(rawBody);

      // 2. Semantic guardrails (DB reads) — before any mutation.
      await this.validateSemantics(parsed);

      // 3. Trust-boundary manifest recheck — before any mutation.
      this.checkManifest(parsed);

      // 4. Mutations: writes (merge) → deletes (deleteL1) → files (scene/persona).
      await this.applyMerges(parsed.diff.merge, result);
      await this.applyDeletes(parsed.diff.deleteL1, result);
      await this.applyRewrites(parsed.diff.rewriteBlock, parsed.diff.rewritePersona, result);

      // 5. Scene index rebuild after file rewrites.
      result.sceneIndexSynced = await this.syncSceneIndex();
      if (!result.sceneIndexSynced) {
        result.status = "failed";
        result.statusCode = 500;
        result.ok = false;
        result.error =
          "syncSceneIndex failed (files applied; scene_index.json rebuilds on the next /memory/validate)";
        return result;
      }

      // 6. Post-apply vec-vs-meta count check.
      const countsOk = await this.verifyCounts(result);
      if (countsOk) {
        result.status = "applied";
        result.ok = true;
      } else {
        result.status = "failed";
        result.statusCode = 500;
        result.ok = false;
      }
      return result;
    } catch (err) {
      if (
        err instanceof ApplyValidationError ||
        err instanceof ManifestDriftError ||
        err instanceof StaleDeleteError ||
        err instanceof ApplyRuntimeError
      ) {
        result.error = err.message;
        result.partial = hasApplied(result);
        result.status = "aborted";
        result.statusCode = err.statusCode;
        return result;
      }
      // Unexpected — propagate to the HTTP layer (500 with raw message).
      throw err;
    }
  }

  // ============================
  // Validation
  // ============================

  private parseRequest(rawBody: unknown): ParsedApplyRequest {
    const parsed = applyRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const pretty = z.prettifyError(parsed.error);
      throw new ApplyValidationError(`Invalid apply request: ${pretty}`);
    }
    return parsed.data as ParsedApplyRequest;
  }

  /**
   * Semantic guardrails (OWASP LLM01/08, ТЗ §5.4): deleteL1 ids ⊆ presented
   * ids; merge target ∈ cluster and target ⊆ current records; rewrite paths
   * from the allowlist (scene_blocks/**, persona.md) AND covered by the
   * manifest baseline (the child may only rewrite what it saw at spawn).
   */
  private async validateSemantics(parsed: ParsedApplyRequest): Promise<void> {
    const { diff, context, manifest } = parsed;

    const presented = new Set(context.presentedRecordIds);
    for (const op of diff.deleteL1 ?? []) {
      if (!presented.has(op.id)) {
        throw new ApplyValidationError(
          `deleteL1 id "${op.id}" was not presented to the memory-keeper (deleteL1 ids must be ⊆ the diff)`,
        );
      }
    }

    const allMergeTargets: string[] = [];
    for (const op of diff.merge ?? []) {
      if (!op.cluster.includes(op.target)) {
        throw new ApplyValidationError(
          `merge target "${op.target}" is not a member of its cluster [${op.cluster.join(", ")}]`,
        );
      }
      for (const member of op.cluster) {
        if (!presented.has(member)) {
          throw new ApplyValidationError(
            `merge cluster member "${member}" was not presented to the memory-keeper (cluster ids must be ⊆ the diff)`,
          );
        }
      }
      allMergeTargets.push(op.target);
    }
    if (allMergeTargets.length > 0) {
      const existing = await this.fetchMetaRows(allMergeTargets);
      for (const target of allMergeTargets) {
        if (!existing.has(target)) {
          throw new ApplyValidationError(`merge target "${target}" does not exist in records`);
        }
      }
    }

    for (const op of diff.rewriteBlock ?? []) {
      this.assertAllowedRewritePath(op.path);
      if (!(op.path in manifest.baseline)) {
        throw new ApplyValidationError(
          `rewriteBlock path "${op.path}" is not covered by the manifest baseline (child may only rewrite what it saw at spawn)`,
        );
      }
      if (!op.content.includes(META_START) || !op.content.includes(META_END)) {
        throw new ApplyValidationError(
          `rewriteBlock content for "${op.path}" must include ${META_START} and ${META_END} (validator requires META frontmatter)`,
        );
      }
    }
    if (diff.rewritePersona !== undefined) {
      if (!("persona.md" in manifest.baseline)) {
        throw new ApplyValidationError(
          "rewritePersona requires persona.md in the manifest baseline (child may only rewrite what it saw at spawn)",
        );
      }
    }
  }

  /** Allowlist: scene_blocks/<slug>/<file>.md or persona.md, no traversal
   * (shared with the read side via block-paths.ts — Unicode scene names
   * allowed; the old ASCII-only regex dropped Cyrillic rewriteBlock ops). */
  private assertAllowedRewritePath(relPath: string): void {
    if (!isSceneBlockRelPathOrPersona(relPath)) {
      throw new ApplyValidationError(`rewriteBlock path "${relPath}" is not in the allowlist (scene_blocks/** or persona.md)`);
    }
    const resolved = this.resolveWithinDataDir(relPath);
    if (!resolved) {
      throw new ApplyValidationError(`rewriteBlock path "${relPath}" escapes the data dir`);
    }
  }

  /**
   * Trust-boundary recheck (ТЗ §5.5): every baseline file must be byte-identical
   * (sha256) to the spawn-time snapshot, EXCEPT files whose current content
   * equals a rewrite target in this same diff — those were changed by a
   * previous apply run (heal re-run), which is our own write, not a drift.
   */
  private checkManifest(parsed: ParsedApplyRequest): void {
    const { manifest, diff } = parsed;
    const rewrites = new Map<string, string>();
    for (const op of diff.rewriteBlock ?? []) rewrites.set(op.path, op.content);
    if (diff.rewritePersona !== undefined) rewrites.set("persona.md", diff.rewritePersona);

    for (const [relPath, baselineHash] of Object.entries(manifest.baseline)) {
      const resolved = this.resolveWithinDataDir(relPath);
      if (!resolved) {
        throw new ManifestDriftError(`manifest path "${relPath}" escapes the data dir`);
      }
      let current: string;
      try {
        current = fs.readFileSync(resolved, "utf-8");
      } catch {
        throw new ManifestDriftError(`manifest drift: "${relPath}" missing on disk (baseline hash ${baselineHash.slice(0, 8)}…)`);
      }
      const currentHash = createHash("sha256").update(current).digest("hex");
      if (currentHash === baselineHash) continue;
      // Tolerance: content already equals the diff's rewrite for this path
      // (our own previous application — heal path).
      const expected = rewrites.get(relPath);
      if (expected !== undefined && current === expected) continue;
      throw new ManifestDriftError(
        `manifest drift: "${relPath}" changed since spawn (baseline ${baselineHash.slice(0, 8)}…, current ${currentHash.slice(0, 8)}…)`,
      );
    }
  }

  // ============================
  // Mutations
  // ============================

  /** Merge: writeMemory (target survives with merged content) then
   * deleteL1Batch(cluster∖target). Pre-check: already applied when the target
   * exists and every other member is gone → skip (idempotent heal). */
  private async applyMerges(
    ops: Array<{ cluster: string[]; target: string; content: string }> | undefined,
    result: ApplyResult,
  ): Promise<void> {
    if (!ops || ops.length === 0) return;
    const { logger, dataDir, vectorStore, embeddingService } = this.deps;

    for (const op of ops) {
      const rows = await this.fetchMetaRows([op.target, ...op.cluster]);
      const targetRow = rows.get(op.target);
      const membersPresent = op.cluster.some((m) => m !== op.target && rows.has(m));

      if (targetRow && !membersPresent) {
        result.skipped.merges.push(op.target);
        continue;
      }
      if (!targetRow) {
        // Target gone but members remain — nothing sane to merge into.
        throw new ApplyRuntimeError(`merge target "${op.target}" is missing (members still present)`);
      }

      const memory = {
        content: op.content,
        type: (targetRow.type as MemoryType) || "episodic",
        priority: targetRow.priority ?? 50,
        source_message_ids: [],
        metadata: parseMetadata(targetRow.metadata_json),
        scene_name: targetRow.scene_name ?? "",
        // The committed ExtractedMemory has no `scope` (I3/I4 adds it). Passing
        // it is harmless on the committed writer — unknown fields are ignored —
        // and preserves the merge target's scope on the merged tree.
        scope: targetRow.scope === "project" ? "project" : undefined,
      } as ExtractedMemory;
      const decision: DedupDecision = {
        record_id: op.target,
        action: "merge",
        target_ids: [], // members are removed explicitly below (write-then-delete)
        merged_content: op.content,
        merged_type: memory.type,
        merged_priority: memory.priority,
      };

      let written: Awaited<ReturnType<typeof writeMemory>>;
      try {
        written = await writeMemory({
          memory,
          decision,
          baseDir: dataDir,
          sessionKey: targetRow.session_key,
          sessionId: targetRow.session_id,
          // The committed writeMemory signature has no `projectId` (I3/I4 adds
          // it). The committed writer ignores the extra key; the merged one
          // uses it to keep the merged record's project attribution.
          projectId: targetRow.project_id,
          logger,
          vectorStore,
          embeddingService,
        } as Parameters<typeof writeMemory>[0]);
      } catch (err) {
        throw new ApplyRuntimeError(
          `writeMemory failed for merge target "${op.target}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!written) {
        throw new ApplyRuntimeError(`writeMemory returned null for merge target "${op.target}"`);
      }

      const members = op.cluster.filter((m) => m !== op.target);
      if (members.length > 0 && vectorStore) {
        const ok = await vectorStore.deleteL1Batch(members);
        if (!ok) {
          throw new ApplyRuntimeError(`deleteL1Batch failed after merge "${op.target}" (members [${members.join(", ")}])`);
        }
      }
      result.applied.merges.push(op.target);
      logger.info?.(`[memory/apply] merged ${op.cluster.length} records into ${op.target}`);
    }
  }

  /**
   * Deletes with stale-re-check: per-id updatedAt from the diff vs the current
   * updated_time. Missing target → already applied → skip. Drift → abort
   * (fresh data must not be lost). deleteL1Batch(false) → abort.
   */
  private async applyDeletes(
    ops: Array<{ id: string; updatedAt: string }> | undefined,
    result: ApplyResult,
  ): Promise<void> {
    if (!ops || ops.length === 0) return;
    const rows = await this.fetchMetaRows(ops.map((o) => o.id));

    const toDelete: string[] = [];
    for (const op of ops) {
      const row = rows.get(op.id);
      if (!row) {
        result.skipped.deletes.push(op.id); // already applied (re-run)
        continue;
      }
      if (row.updated_time !== op.updatedAt) {
        throw new StaleDeleteError(
          `delete target "${op.id}" was updated since the diff was built ` +
          `(diff updatedAt "${op.updatedAt}", current "${row.updated_time}") — aborting to protect fresh data`,
        );
      }
      toDelete.push(op.id);
    }

    if (toDelete.length > 0 && this.deps.vectorStore) {
      const ok = await this.deps.vectorStore.deleteL1Batch(toDelete);
      if (!ok) {
        throw new ApplyRuntimeError(`deleteL1Batch failed for [${toDelete.join(", ")}]`);
      }
    }
    result.applied.deletes.push(...toDelete);
  }

  /** Rewrite scene/persona atomically (tmp + rename) with a backup. */
  private async applyRewrites(
    blocks: Array<{ path: string; content: string }> | undefined,
    persona: string | undefined,
    result: ApplyResult,
  ): Promise<void> {
    const targets: Array<{ relPath: string; content: string }> = [];
    for (const op of blocks ?? []) targets.push({ relPath: op.path, content: op.content });
    if (persona !== undefined) targets.push({ relPath: "persona.md", content: persona });

    for (const target of targets) {
      const resolved = this.resolveWithinDataDir(target.relPath);
      if (!resolved) {
        throw new ApplyRuntimeError(`rewrite path "${target.relPath}" escapes the data dir`);
      }

      let current: string | null = null;
      try {
        current = fs.readFileSync(resolved, "utf-8");
      } catch {
        current = null; // file raced away — backup skipped, write recreates it
      }
      if (current === target.content) {
        result.skipped.rewrites.push(target.relPath); // already applied (re-run)
        continue;
      }

      try {
        if (current !== null) {
          await this.writeBackup(target.relPath, current);
        }
        await atomicWrite(resolved, target.content);
      } catch (err) {
        throw new ApplyRuntimeError(
          `rewrite "${target.relPath}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      result.applied.rewrites.push(target.relPath);
      this.deps.logger.info?.(`[memory/apply] rewrote ${target.relPath} (${target.content.length} chars)`);
    }
  }

  // ============================
  // Files
  // ============================

  private async writeBackup(relPath: string, content: string): Promise<void> {
    const backupDir = path.join(this.deps.dataDir, ".backup");
    await fs.promises.mkdir(backupDir, { recursive: true });
    const safeName = relPath.replace(/[^A-Za-z0-9._-]+/g, "_");
    const backupPath = path.join(backupDir, `apply-${Date.now()}-${safeName}.bak`);
    await fs.promises.writeFile(backupPath, content, "utf-8");
  }

  private async syncSceneIndex(): Promise<boolean> {
    try {
      // The committed scene-index module only exposes the legacy flat single-call
      // API; the I3/I4 scene split adds syncSceneIndexAllProjects (the per-project
      // rebuild apply needs after rewriting scene_blocks/<slug>). Feature-detect so
      // the committed tree compiles and runs standalone, while the merged tree
      // keeps the authoritative module implementation.
      const allProjects = (
        sceneIndex as typeof sceneIndex & {
          syncSceneIndexAllProjects?: (dataDir: string) => Promise<unknown>;
        }
      ).syncSceneIndexAllProjects;
      if (typeof allProjects === "function") {
        await allProjects(this.deps.dataDir);
      } else {
        await this.syncSceneIndexPerProject();
      }
      return true;
    } catch (err) {
      this.deps.logger.warn?.(
        `[memory/apply] syncSceneIndex failed: ${err instanceof Error ? err.message : String(err)} — ` +
        "scene_index.json rebuilds on the next /memory/validate",
      );
      return false;
    }
  }

  /**
   * Committed-tree fallback for syncSceneIndexAllProjects. The committed
   * scene-index.ts scans scene_blocks/ flat and cannot index the per-project
   * scene_blocks/<slug>/ layout that apply rewrites, so mirror the per-project
   * rebuild here (same layout memory-routes.ts /memory/validate expects:
   * .metadata/scene_index/<slug>.json). Superseded by the I3/I4 module export
   * once that lands.
   */
  private async syncSceneIndexPerProject(): Promise<void> {
    const blocksRoot = path.join(this.deps.dataDir, "scene_blocks");
    let slugs: string[];
    try {
      slugs = (await fs.promises.readdir(blocksRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return; // no scene_blocks yet — nothing to index
    }

    for (const slug of slugs) {
      const blocksDir = path.join(blocksRoot, slug);
      let files: string[];
      try {
        files = (await fs.promises.readdir(blocksDir)).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }

      const entries: sceneIndex.SceneIndexEntry[] = [];
      for (const file of files) {
        try {
          const raw = await fs.promises.readFile(path.join(blocksDir, file), "utf-8");
          const block = parseSceneBlock(raw, file);
          entries.push({
            filename: file,
            summary: block.meta.summary,
            heat: block.meta.heat,
            created: block.meta.created,
            updated: block.meta.updated,
          });
        } catch {
          // Deleted between readdir and readFile — skip it, keep the rest.
          continue;
        }
      }

      const indexPath = path.join(this.deps.dataDir, ".metadata", "scene_index", `${slug}.json`);
      await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.promises.writeFile(indexPath, JSON.stringify(entries, null, 2), "utf-8");
    }
  }

  // ============================
  // Post-apply count check (ТЗ §5.5/§5.6)
  // ============================

  /**
   * vec-vs-meta count check: both COUNTs + orphan/missing id-sets in ONE store
   * transaction. Match → done. Mismatch → orphan purge (per-id stmtDeleteVec,
   * one transaction) → reindexAll with a livelock cap (MAX_REINDEX_RETRIES) →
   * per-row backfill of the remaining delta (reindexL1Records) + L0 window-skip
   * heal (reindexL0Records) → unresolved → failed.
   */
  private async verifyCounts(result: ApplyResult): Promise<boolean> {
    const store = this.deps.vectorStore;
    if (!store?.consistencyCheck) return true; // backend cannot check — skip

    const updateCounts = (c: {
      metaCount: number;
      vecCount: number | null;
      orphanIds: string[];
      missingIds?: string[];
      l0VecCount?: number | null;
      l0MissingIds?: string[];
    }): void => {
      result.counts = {
        metaCount: c.metaCount,
        vecCount: c.vecCount,
        consistent: c.vecCount === null ? null : c.vecCount === c.metaCount,
      };
    };

    let check = await store.consistencyCheck();
    updateCounts(check);
    // No vec0 tables / degraded → nothing to reconcile (NOT a mismatch).
    if (check.vecCount === null) return true;
    if (check.vecCount === check.metaCount) return true;

    this.deps.logger.warn?.(
      `[memory/apply] vec-vs-meta mismatch after apply: vec=${check.vecCount} meta=${check.metaCount} orphans=${check.orphanIds.length}`,
    );

    // Orphan purge first — in-process reindexAll per-row cannot remove
    // vec rows without a meta row (sqlite.ts:1914).
    if (check.orphanIds.length > 0 && store.purgeOrphanVectors) {
      const purged = await store.purgeOrphanVectors(check.orphanIds);
      if (purged) {
        check = await store.consistencyCheck();
        updateCounts(check);
        if (check.vecCount === null) return true;
        if (check.vecCount === check.metaCount) return true;
      }
    }

    // Still mismatched → full reindex (livelock-capped, ТЗ §5.6).
    if (!this.deps.embeddingService) {
      result.needsReindex = true;
      result.error = "vec-vs-meta mismatch unresolved (no embedding service available for reindex)";
      return false;
    }
    const embedFn = (text: string) => this.deps.embeddingService!.embed(text);
    for (let attempt = 1; attempt <= MAX_REINDEX_RETRIES; attempt++) {
      this.deps.logger.warn?.(
        `[memory/apply] reindexAll attempt ${attempt}/${MAX_REINDEX_RETRIES} (vec-vs-meta mismatch)`,
      );
      await store.reindexAll(embedFn);
      result.reindexed = true;
      check = await store.consistencyCheck();
      updateCounts(check);
      if (check.vecCount === null) return true;
      if (check.vecCount === check.metaCount) return true;
    }

    // Livelock cap reached and still mismatched → backfill the delta per-row
    // (reindexL1Records) INSTEAD of a third full reindex — skip-dual-write
    // during the reindex window produces exactly this delta, and per-row
    // delete+insert is idempotent under concurrent dual-writes.
    const missingIds = check.missingIds ?? [];
    if (missingIds.length > 0 && store.reindexL1Records) {
      this.deps.logger.warn?.(
        `[memory/apply] livelock cap reached — backfilling ${missingIds.length} L1 row(s) per-row`,
      );
      await store.reindexL1Records(missingIds, embedFn);
      result.reindexed = true;
      check = await store.consistencyCheck();
      updateCounts(check);
    }

    // L0 window-skip heal: L0 vector rows skipped during the reindex window
    // (updateL0Embedding returns false while the flag is set, auto-capture
    // treats it as non-fatal) are backfilled per-row here so messages captured
    // during the window stay searchable. Runs regardless of the L1 outcome.
    // Idempotent under a concurrent background embed (delete+insert replaces).
    const l0Missing = check.l0MissingIds ?? [];
    if (l0Missing.length > 0 && store.reindexL0Records) {
      this.deps.logger.warn?.(
        `[memory/apply] backfilling ${l0Missing.length} L0 row(s) per-row (reindex window-skip heal)`,
      );
      await store.reindexL0Records(l0Missing, embedFn);
      result.reindexed = true;
    }

    if (check.vecCount === null) return true;
    if (check.vecCount === check.metaCount) return true;

    result.needsReindex = true;
    result.error =
      `vec-vs-meta mismatch unresolved after ${MAX_REINDEX_RETRIES} reindex attempt(s) + per-row backfill ` +
      `(vec=${check.vecCount}, meta=${check.metaCount})`;
    return false;
  }

  // ============================
  // Helpers
  // ============================

  /** Resolve a dataDir-relative path and reject traversal escapes. */
  private resolveWithinDataDir(relPath: string): string | null {
    const dataRoot = path.resolve(this.deps.dataDir);
    const resolved = path.resolve(dataRoot, relPath);
    if (resolved !== dataRoot && !resolved.startsWith(dataRoot + path.sep)) return null;
    return resolved;
  }

  /**
   * Fetch record metadata rows by id via a FRESH readonly connection. A
   * connection reused across the mutation loop would hold a stale WAL
   * snapshot and false-abort the stale-delete re-check for later ops.
   */
  private async fetchMetaRows(ids: string[]): Promise<Map<string, MetaRow>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, MetaRow>();
    if (unique.length === 0) return out;

    const dbPath = path.join(this.deps.dataDir, "vectors.db");
    const placeholders = unique.map(() => "?").join(", ");

    try {
      const db = openReadonlySqlite(dbPath);
      try {
        // project_id/scope are I3/I4 columns (ALTER TABLE migration); the
        // committed l1_records schema predates them. Probe once so the same
        // query serves both trees — absent columns read as ''.
        const columns = new Set(
          (db.prepare("PRAGMA table_info(l1_records)").all() as Array<{ name: string }>).map((c) => c.name),
        );
        const projectIdExpr = columns.has("project_id") ? "project_id" : "'' AS project_id";
        const scopeExpr = columns.has("scope") ? "COALESCE(scope, '')" : "''";
        const sql =
          "SELECT record_id, updated_time, type, priority, scene_name, session_key, session_id, " +
          `${projectIdExpr}, ${scopeExpr} AS scope, metadata_json ` +
          `FROM l1_records WHERE record_id IN (${placeholders})`;
        const rows = db.prepare(sql).all(...unique) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const recordId = String(row.record_id ?? "");
          out.set(recordId, {
            record_id: recordId,
            updated_time: String(row.updated_time ?? ""),
            type: String(row.type ?? ""),
            priority: typeof row.priority === "number" ? row.priority : 50,
            scene_name: String(row.scene_name ?? ""),
            session_key: String(row.session_key ?? ""),
            session_id: String(row.session_id ?? ""),
            project_id: String(row.project_id ?? ""),
            scope: String(row.scope ?? ""),
            metadata_json: String(row.metadata_json ?? "{}"),
          });
        }
        return out;
      } finally {
        db.close();
      }
    } catch (err) {
      // A read failure must abort, not masquerade as "already applied" — an
      // empty map would silently skip every deleteL1 target and report a
      // successful 200 apply (contradicts abort-on-runtime-failure).
      throw new ApplyRuntimeError(
        `record read failed for apply: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ============================
// HTTP handler (POST /memory/apply)
// ============================

export interface ApplyRouteContext {
  core: TdaiCore;
  config: GatewayConfig;
  logger: Logger;
}

/**
 * Route handler: Content-Type must be application/json (критерий 20); the
 * write-gate (Bearer OR x-memory-token) is enforced by server.ts BEFORE this
 * handler. Status mapping: 200 applied · 400 validation · 409 drift/stale/
 * abort-with-heal · 500 runtime/failed.
 */
export async function handleMemoryApply(
  ctx: ApplyRouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    sendError(res, 415, "Content-Type must be application/json");
    return;
  }

  let body: unknown;
  try {
    body = await parseJsonBody<unknown>(req);
  } catch {
    sendError(res, 400, "Invalid JSON body");
    return;
  }

  const executor = new ApplyExecutor({
    dataDir: ctx.config.data.baseDir,
    logger: ctx.logger,
    vectorStore: ctx.core.getVectorStore(),
    embeddingService: ctx.core.getEmbeddingService(),
  });

  let result: ApplyResult;
  try {
    result = await executor.apply(body);
  } catch (err) {
    ctx.logger.error?.(
      `[memory/apply] unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    sendError(res, 500, `Apply executor failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }

  // Aborts carry their own status code (400 validation · 409 drift/stale ·
  // 500 runtime); "failed" (syncSceneIndex / unresolved counts) is a 500.
  const status = result.statusCode ?? (result.status === "failed" ? 500 : 400);
  sendJson(res, status, result);
}

// ============================
// Module helpers
// ============================

function hasApplied(result: ApplyResult): boolean {
  return (
    result.applied.merges.length > 0 ||
    result.applied.deletes.length > 0 ||
    result.applied.rewrites.length > 0
  );
}

function parseMetadata(raw: string): ExtractedMemory["metadata"] {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ExtractedMemory["metadata"];
  } catch {
    // malformed metadata_json — fall through to {}
  }
  return {};
}

/** Atomic write: tmp file in the same directory + rename. */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.apply-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.promises.writeFile(tmpPath, content, "utf-8");
  await fs.promises.rename(tmpPath, targetPath);
}
