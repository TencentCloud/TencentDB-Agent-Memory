/**
 * Memory read routes + discovery (wave tdai-memory-subagents-2026-08-02, P3).
 *
 * Auth-free on loopback (same posture as /status):
 *   GET /memory/info       — discovery: {dataDir, tokenPath, version}
 *   GET /memory/records    — L1 records (filters: since / project / type)
 *   GET /memory/duplicates — vector candidate-finding ONLY (cosine topK +
 *                            sameScope), NO LLM calls (l1-dedup mechanism)
 *   GET /memory/blocks     — scene/persona files with size + limit
 *   GET /memory/validate   — sizes, JSON integrity, META frontmatter,
 *                            vec-vs-meta count consistency
 *
 * All routes are read-only: no DB writes, no LLM invocations (INVARIANT
 * nogo-records-rewrite / nogo-l1-prompt). Nothing here can expose secrets —
 * /memory/info returns the token file PATH, never its content.
 */

import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { TdaiCore } from "../core/tdai-core.js";
import type { GatewayConfig } from "./config.js";
import type { LoopbackTokenManager } from "./token.js";
import type { Logger } from "../core/types.js";
import type { L1SearchResult } from "../core/store/types.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { sendJson, sendError, openReadonlySqlite, type ReadonlySqlite } from "./http-utils.js";
import { isAddressableBlockPath } from "./block-paths.js";
import type {
  MemoryInfoResponse,
  MemoryRecordsResponse,
  MemoryRecordRow,
  MemoryBlocksResponse,
  MemoryBlockInfo,
  MemoryDuplicatesResponse,
  MemoryValidateResponse,
} from "./types.js";

// Runtime-agnostic SQLite loader (same pattern as src/core/store/sqlite.ts):
// bun:sqlite under Bun (the systemd gateway runtime), node:sqlite under Node
// (vitest forks). Only readonly queries are used here — these routes never
// write to the store (INVARIANT nogo-records-rewrite).
// The loader itself lives in http-utils.ts (single source of truth — it is
// also used by server.ts /status totals); this module imports it.

// Memory content limits enforced by the memory-keeper role (ТЗ §5.6):
// scene blocks ≤ 1500 chars, persona.md ≤ 2000 chars. Sizes here are
// measured in characters (not bytes) — the role prompt caps are char-based.
const SCENE_LIMIT_CHARS = 1500;
const PERSONA_LIMIT_CHARS = 2000;

// Scene block META delimiters (format contract of scene-format.ts).
const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

/**
 * Scope-compatible duplicate candidate: L1SearchResult plus the optional
 * project-scoping fields. Widened so this module typechecks both against the
 * committed core types and the workspace's uncommitted scoping additions.
 */
type DuplicateCandidate = L1SearchResult & { scope?: string; project_id?: string };

/**
 * Same-scope predicate, mirror of `l1-dedup.sameScope` (a workspace-uncommitted
 * export). Merging across a scope boundary destroys data, so candidates whose
 * scope differs from the queried memory are dropped. Kept local (with the same
 * semantics) so the committed tree typechecks without the uncommitted export.
 */
function sameScope(
  candidate: { scope?: string; project_id?: string },
  memoryScope: "global" | "project" | undefined,
  projectId: string,
): boolean {
  // Legacy records (no scope) behave as before.
  if (!candidate.scope) return true;
  const wanted = memoryScope ?? "global";
  if (candidate.scope !== wanted) return false;
  return wanted !== "project" || candidate.project_id === projectId;
}

export interface MemoryRoutesContext {
  core: TdaiCore;
  config: GatewayConfig;
  tokenManager: LoopbackTokenManager;
  logger: Logger;
  version: string;
}

// ============================
// /memory/info
// ============================

/**
 * Discovery route for the pi extension: the extension knows only
 * TDAI_GATEWAY_URL (tdai-memory-shared.ts:64), so it fetches the token file
 * path here and reads the credential file itself. Never exposes the token.
 */
export function handleMemoryInfo(ctx: MemoryRoutesContext, res: http.ServerResponse): void {
  ctx.tokenManager.ensure();
  const response: MemoryInfoResponse = {
    dataDir: ctx.config.data.baseDir,
    tokenPath: ctx.tokenManager.tokenPath,
    version: ctx.version,
  };
  sendJson(res, 200, response);
}

// ============================
// /memory/records
// ============================

export async function handleMemoryRecords(
  ctx: MemoryRoutesContext,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const since = url.searchParams.get("since") ?? undefined;
  const project = url.searchParams.get("project") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 200);

  const rows = queryL1Rows(ctx.config.data.baseDir, ctx.logger, { since, project, type, limit });
  if (!rows) {
    sendError(res, 500, "memory records query failed");
    return;
  }
  const response: MemoryRecordsResponse = { total: rows.length, records: rows as unknown as MemoryRecordRow[] };
  sendJson(res, 200, response);
}

// ============================
// /memory/duplicates
// ============================

/**
 * Vector-only candidate finding: batch-embed records, cosine search topK,
 * sameScope filter — exactly the l1-dedup candidate mechanism (l1-dedup.ts
 * findCandidatesByVector), WITHOUT the LLM judgment phase.
 *
 * Explicit deps (store/embed/dataDir/logger) instead of the route ctx so the
 * P10 dashboard can reuse the same cluster-finding for memory_health.md
 * (fail-open when resources are missing).
 */
export async function findDuplicateClusters(
  deps: {
    store?: IMemoryStore;
    embed?: EmbeddingService;
    dataDir: string;
    logger: Logger;
  },
  opts: { since?: string; project?: string; type?: string; topK: number; threshold: number; limit: number },
): Promise<{
  clusters: MemoryDuplicatesResponse["clusters"];
  degraded: boolean;
  reason?: string;
}> {
  const { store, embed, dataDir, logger } = deps;
  if (!store || !embed) {
    return { clusters: [], degraded: true, reason: "vector store or embedding service unavailable" };
  }

  const rows = queryL1Rows(dataDir, logger, { since: opts.since, project: opts.project, type: opts.type, limit: opts.limit });
  if (!rows) {
    return { clusters: [], degraded: true, reason: "memory records query failed" };
  }

  const clusters: MemoryDuplicatesResponse["clusters"] = [];
  for (const row of rows) {
    const content = typeof row.content === "string" ? row.content : "";
    if (!content) continue;
    let vec: Float32Array;
    try {
      vec = await embed.embed(content);
    } catch (err) {
      logger.warn(
        `[memory/duplicates] embed failed for ${String(row.record_id)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const projectId = typeof row.project_id === "string" ? row.project_id : "";
    const scope = typeof row.scope === "string" && row.scope ? (row.scope as "global" | "project") : undefined;

    // The workspace's sqlite store accepts a 4th projectId argument for
    // SQL-level scope filtering; the committed signature takes 3. The widened
    // call type covers both (extra args are ignored by older signatures).
    // Cast at the call site so `this` stays bound to the store.
    const hits = await (store.searchL1Vector as unknown as (
      emb: Float32Array,
      topK?: number,
      text?: string,
      projectId?: string,
    ) => Promise<DuplicateCandidate[]>)(vec, opts.topK, content, projectId);
    const similar = hits
      .filter((h) => h.record_id !== row.record_id)
      .filter((h) => sameScope(h, scope, projectId))
      .filter((h) => h.score >= opts.threshold)
      .map((h) => ({
        record_id: h.record_id,
        score: Math.round(h.score * 10_000) / 10_000,
        scope: h.scope ?? "",
        project_id: h.project_id ?? "",
        type: h.type,
      }));
    if (similar.length > 0) {
      clusters.push({ record_id: String(row.record_id), similar });
    }
  }

  return { clusters, degraded: false };
}

export async function handleMemoryDuplicates(
  ctx: MemoryRoutesContext,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const since = url.searchParams.get("since") ?? undefined;
  const project = url.searchParams.get("project") ?? undefined;
  const type = url.searchParams.get("type") ?? undefined;
  const topK = clampInt(url.searchParams.get("topK"), 1, 20, ctx.config.memory.embedding.conflictRecallTopK || 5);
  const threshold = clampFloat(url.searchParams.get("threshold"), 0, 1, ctx.config.memory.recall.scoreThreshold);
  const limit = clampInt(url.searchParams.get("limit"), 1, 500, 100);

  const found = await findDuplicateClusters(
    { store: ctx.core.getVectorStore(), embed: ctx.core.getEmbeddingService(), dataDir: ctx.config.data.baseDir, logger: ctx.logger },
    { since, project, type, topK, threshold, limit },
  );
  const response: MemoryDuplicatesResponse = {
    total: found.clusters.length,
    clusters: found.clusters,
    topK,
    threshold,
    degraded: found.degraded,
    reason: found.reason,
  };
  sendJson(res, 200, response);
}

// ============================
// /memory/blocks
// ============================

export async function handleMemoryBlocks(
  ctx: MemoryRoutesContext,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const dataDir = ctx.config.data.baseDir;

  // `?path=<rel>` — read the CONTENT of one addressable block (scene_blocks/**
  // or persona.md). Additive read-only route used by the keeper-tools
  // fetch_blocks.py; sanitized like cleanup.ts (decode → reject .. / absolute /
  // empty → allowlist → realpath containment → read the realpath'd path).
  const rel = url.searchParams.get("path");
  if (rel !== null) {
    if (!isAddressableBlockPath(rel)) {
      sendError(res, 400, `Not an addressable memory block: ${rel}`);
      return;
    }
    let resolved: string;
    try {
      resolved = path.resolve(dataDir, rel);
      const rootReal = await fs.promises.realpath(dataDir);
      let targetReal: string;
      try {
        targetReal = await fs.promises.realpath(resolved);
      } catch {
        // Missing file / broken symlink → 404 (tres-realpath-enoent).
        sendError(res, 404, `Block not found: ${rel}`);
        return;
      }
      const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
      if (targetReal !== rootReal && !targetReal.startsWith(rootPrefix)) {
        sendError(res, 400, `Block escapes data root: ${rel}`);
        return;
      }
      if (!isAddressableBlockPath(path.relative(rootReal, targetReal))) {
        sendError(res, 400, `Block escapes allowlist: ${rel}`);
        return;
      }
      const stat = await fs.promises.stat(targetReal);
      if (!stat.isFile()) {
        sendError(res, 400, `Not a file: ${rel}`);
        return;
      }
      const content = await fs.promises.readFile(targetReal, "utf-8");
      const kind = rel === "persona.md" ? "persona" : "scene";
      sendJson(res, 200, { path: rel, kind, content });
    } catch (err) {
      sendError(res, 500, `Failed to read block: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  const { blocks } = collectBlockStats(dataDir);
  const response: MemoryBlocksResponse = {
    limits: { scene: SCENE_LIMIT_CHARS, persona: PERSONA_LIMIT_CHARS },
    blocks,
  };
  sendJson(res, 200, response);
}

// ============================
// /memory/validate
// ============================

export async function handleMemoryValidate(
  ctx: MemoryRoutesContext,
  _url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const dataDir = ctx.config.data.baseDir;

  const { blocks, overLimit } = collectBlockStats(dataDir);
  const json = checkJsonIntegrity(dataDir);
  const meta = checkSceneMeta(dataDir);
  const vecMeta = checkVecMetaCounts(dataDir);

  const response: MemoryValidateResponse = {
    dataDir,
    checks: {
      sizes: { checked: blocks.length, overLimit },
      json,
      meta,
      vecMeta,
    },
  };
  sendJson(res, 200, response);
}

// ============================
// Shared helpers
// ============================

interface L1RowFilter {
  since?: string;
  project?: string;
  type?: string;
  limit: number;
}

/**
 * Query l1_records (readonly) with optional since/project/type filters.
 * Returns null on DB failure (caller turns it into a 500).
 *
 * Schema-adaptive: the `project_id` / `scope` columns are added by the
 * workspace's uncommitted scoping migrations; on a committed tree they do not
 * exist. Column presence is detected via PRAGMA and the SELECT falls back to
 * empty literals so the response shape stays uniform in both worlds. A
 * `project` filter that cannot be honored (no column) is ignored.
 */
function queryL1Rows(dataDir: string, logger: Logger, filter: L1RowFilter): Array<Record<string, unknown>> | null {
  const dbPath = path.join(dataDir, "vectors.db");
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.since) {
    where.push("(updated_time != '' AND updated_time >= ?) OR (updated_time = '' AND created_time >= ?)");
    params.push(filter.since, filter.since);
  }
  if (filter.type !== undefined) {
    where.push("type = ?");
    params.push(filter.type);
  }

  try {
    const db = openReadonlySqlite(dbPath);
    try {
      let scopeCols = "";
      try {
        const cols = db.prepare("PRAGMA table_info(l1_records)").all() as Array<{ name: string }>;
        const hasScopeCols = cols.some((c) => c.name === "project_id") && cols.some((c) => c.name === "scope");
        if (hasScopeCols) {
          scopeCols = ", project_id, COALESCE(scope, '') AS scope";
          // Project predicate goes into the shared WHERE clause so that a
          // project-only request (no since/type) still emits a valid
          // `WHERE project_id = ?` — a bare `AND project_id = ?` after
          // `FROM l1_records` is a syntax error (500 on scoped schemas).
          if (filter.project !== undefined) {
            where.push("project_id = ?");
            params.push(filter.project);
          }
        }
      } catch {
        // PRAGMA failure — treat as legacy schema.
      }

      const sql =
        "SELECT record_id, content, type, priority, scene_name, session_key, session_id, " +
        "timestamp_str, created_time, updated_time, metadata_json" +
        scopeCols +
        " FROM l1_records" +
        (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
        " ORDER BY MAX(updated_time, created_time) DESC, record_id DESC LIMIT ?";
      params.push(filter.limit);

      return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  } catch (err) {
    logger.warn(`[memory] l1_records query failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Collect scene block + persona stats: byte size, char count, per-kind limit.
 * Char count is the relevant measure — the memory-keeper role caps are
 * char-based (scene 1500, persona 2000). Exported for the P10 dashboard.
 */
export function collectBlockStats(dataDir: string): { blocks: MemoryBlockInfo[]; overLimit: MemoryBlockInfo[] } {
  const blocks: MemoryBlockInfo[] = [];
  const sceneRoot = path.join(dataDir, "scene_blocks");
  try {
    const slugs = fs
      .readdirSync(sceneRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const slug of slugs) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(sceneRoot, slug));
      } catch {
        continue;
      }
      for (const file of files.sort()) {
        if (!file.endsWith(".md")) continue;
        const fullPath = path.join(sceneRoot, slug, file);
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          blocks.push({
            path: `scene_blocks/${slug}/${file}`,
            kind: "scene",
            filename: file,
            project: slug,
            size: raw.length,
            limit: SCENE_LIMIT_CHARS,
            over: raw.length > SCENE_LIMIT_CHARS,
          });
        } catch {
          // File raced away between readdir and readFile — skip.
        }
      }
    }
  } catch {
    // scene_blocks/ not present yet.
  }

  const personaPath = path.join(dataDir, "persona.md");
  try {
    const raw = fs.readFileSync(personaPath, "utf-8");
    blocks.push({
      path: "persona.md",
      kind: "persona",
      filename: "persona.md",
      size: raw.length,
      limit: PERSONA_LIMIT_CHARS,
      over: raw.length > PERSONA_LIMIT_CHARS,
    });
  } catch {
    // No persona yet.
  }

  return { blocks, overLimit: blocks.filter((b) => b.over) };
}

/** JSON integrity: every line of records/*.jsonl and every scene_index/*.json. */
function checkJsonIntegrity(dataDir: string): MemoryValidateResponse["checks"]["json"] {
  const malformed: Array<{ file: string; line: number }> = [];
  let checkedFiles = 0;

  const recordsDir = path.join(dataDir, "records");
  try {
    for (const file of fs.readdirSync(recordsDir).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      checkedFiles++;
      const lines = fs.readFileSync(path.join(recordsDir, file), "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        try {
          JSON.parse(line);
        } catch {
          malformed.push({ file: `records/${file}`, line: i + 1 });
        }
      });
    }
  } catch {
    // records/ not present yet.
  }

  const indexDir = path.join(dataDir, ".metadata", "scene_index");
  try {
    for (const file of fs.readdirSync(indexDir)) {
      if (!file.endsWith(".json")) continue;
      checkedFiles++;
      try {
        JSON.parse(fs.readFileSync(path.join(indexDir, file), "utf-8"));
      } catch {
        malformed.push({ file: `.metadata/scene_index/${file}`, line: 1 });
      }
    }
  } catch {
    // No scene index yet.
  }

  return { checkedFiles, malformed, valid: malformed.length === 0 };
}

/** META frontmatter presence on every scene block. */
function checkSceneMeta(dataDir: string): MemoryValidateResponse["checks"]["meta"] {
  const missingMeta: string[] = [];
  let checked = 0;
  const sceneRoot = path.join(dataDir, "scene_blocks");
  try {
    const slugs = fs
      .readdirSync(sceneRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const slug of slugs) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(sceneRoot, slug));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        checked++;
        try {
          const raw = fs.readFileSync(path.join(sceneRoot, slug, file), "utf-8");
          if (!raw.includes(META_START) || !raw.includes(META_END)) {
            missingMeta.push(`scene_blocks/${slug}/${file}`);
          }
        } catch {
          // Raced away — treat as missing.
          missingMeta.push(`scene_blocks/${slug}/${file}`);
        }
      }
    }
  } catch {
    // No scene blocks yet.
  }
  return { checked, missingMeta, valid: missingMeta.length === 0 };
}

/**
 * Count logical rows of the l1_vec vec0 table.
 *
 * Querying the vec0 VIRTUAL table directly requires the sqlite-vec extension
 * to be loaded, which a readonly diagnostic connection does not do ("no such
 * module: vec0"). The `l1_vec_rowids` SHADOW table holds one row per logical
 * vector and is queryable without the extension on both runtimes. Falls back
 * to the virtual table when the shadow layout is absent.
 *
 * Returns null when the table does not exist (fresh store / no embedding
 * provider) or the count failed.
 */
function countVecRows(db: ReadonlySqlite): number | null {
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM l1_vec_rowids").get() as { c: number } | null)?.c ?? 0;
  } catch {
    try {
      return (db.prepare("SELECT COUNT(*) AS c FROM l1_vec").get() as { c: number } | null)?.c ?? 0;
    } catch {
      return null;
    }
  }
}

/**
 * vec-vs-meta count consistency: COUNT(l1_records) vs COUNT(l1_vec) in one
 * readonly connection. `consistent` is null when the vec0 table is absent
 * (embedding provider "none" / fresh store) or vectors.db is unavailable.
 * Exported for the P10 dashboard.
 */
export function checkVecMetaCounts(dataDir: string): MemoryValidateResponse["checks"]["vecMeta"] {
  const dbPath = path.join(dataDir, "vectors.db");
  try {
    const db = openReadonlySqlite(dbPath);
    try {
      const metaRow = db.prepare("SELECT COUNT(*) AS c FROM l1_records").get() as { c: number } | null;
      const metaCount = metaRow?.c ?? 0;
      const vecCount = countVecRows(db);
      if (vecCount === null) {
        return {
          metaCount,
          vecCount: null,
          consistent: null,
          note: "l1_vec unavailable (no vec0 table yet)",
        };
      }
      return { metaCount, vecCount, consistent: vecCount === metaCount };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      metaCount: null,
      vecCount: null,
      consistent: null,
      note: `vectors.db unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Clamp a URL int param into [min, max], falling back to `def`. */
function clampInt(raw: string | null, min: number, max: number, def: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a URL float param into [min, max], falling back to `def`. */
function clampFloat(raw: string | null, min: number, max: number, def: number): number {
  const n = raw === null ? NaN : parseFloat(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
