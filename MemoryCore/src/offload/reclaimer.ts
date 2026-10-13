/**
 * OffloadReclaimer: periodic cleanup of stale offload data files.
 *
 * Reclaims disk space by removing:
 *   Step 1 — Expired session JSONL files (offload-*.jsonl)
 *   Step 2 — Orphaned ref MD files (refs/*.md)
 *   Step 3 — Expired MMD files (mmds/*.mmd), protecting active MMD
 *   Step 4 — Oversized debug log files (*.log truncation)
 *   Step 5 — Stale sessions-registry.json entries
 *
 * Each step is independently try/caught — a failure in one step
 * does not prevent subsequent steps from running.
 *
 * All file-age checks use mtime (last modification time).
 */

import { readdir, lstat, unlink, readFile, writeFile, rename, truncate } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import type { PluginLogger } from "./types.js";

// ============================
// Public types
// ============================

/** Configuration for the reclaim operation. */
export interface ReclaimConfig {
  /** Retention period in days. Values < 3 disable reclamation entirely. */
  retentionDays: number;
  /** Max total size in MB for debug log files. 0 = no log rotation. */
  logMaxSizeMb: number;
}

/** Statistics returned after a reclaim run. */
export interface ReclaimStats {
  deletedJsonl: number;
  deletedRefs: number;
  deletedMmds: number;
  truncatedLogs: number;
  prunedRegistryEntries: number;
}

// ============================
// Constants
// ============================

const TAG = "[context-offload][reclaim]";
const MS_PER_DAY = 86_400_000;

// ============================
// Main entry
// ============================

/**
 * Run a full reclamation pass over the offload data directory.
 *
 * Coordinate this destructive pass with writers and other reclaimers.
 * Pre-existing symlinks are skipped; this is not race-free confinement.
 */
export async function reclaimOffloadData(
  dataRoot: string,
  config: ReclaimConfig,
  logger: PluginLogger,
): Promise<ReclaimStats> {
  const stats: ReclaimStats = {
    deletedJsonl: 0,
    deletedRefs: 0,
    deletedMmds: 0,
    truncatedLogs: 0,
    prunedRegistryEntries: 0,
  };

  if (config.retentionDays < 3) {
    logger.debug?.(`${TAG} Skipped: retentionDays=${config.retentionDays} (min effective: 3)`);
    return stats;
  }

  if (!(await isPlainDirectory(dataRoot))) {
    logger.debug?.(`${TAG} Skipped: dataRoot does not exist: ${dataRoot}`);
    return stats;
  }

  const nowMs = Date.now();
  const cutoffMs = nowMs - config.retentionDays * MS_PER_DAY;

  // Discover agent subdirectories (directories inside dataRoot)
  const agentDirs = await discoverAgentDirs(dataRoot);

  // Step 1: Clean expired session JSONL
  try {
    stats.deletedJsonl = await reclaimExpiredJsonl(dataRoot, agentDirs, cutoffMs, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 1 (JSONL) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: Clean orphan ref MD
  try {
    stats.deletedRefs = await reclaimOrphanRefs(agentDirs, cutoffMs, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 2 (refs) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: Clean expired MMD
  try {
    stats.deletedMmds = await reclaimExpiredMmds(agentDirs, cutoffMs, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 3 (MMDs) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4: Log rotation
  try {
    stats.truncatedLogs = await rotateDebugLogs(dataRoot, config.logMaxSizeMb, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 4 (logs) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 5: Registry pruning
  try {
    stats.prunedRegistryEntries = await pruneRegistries(agentDirs, cutoffMs, logger);
  } catch (err) {
    logger.warn(`${TAG} Step 5 (registry) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return stats;
}

// ============================
// Step helpers
// ============================

async function isPlainDirectory(filePath: string): Promise<boolean> {
  try { return (await lstat(filePath)).isDirectory(); } catch { return false; }
}
async function isRegularFile(filePath: string): Promise<boolean> {
  try { return (await lstat(filePath)).isFile(); } catch { return false; }
}

/** Discover agent subdirectories under dataRoot. */
async function discoverAgentDirs(dataRoot: string): Promise<string[]> {
  const entries = await readdir(dataRoot, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(dataRoot, e.name));
}

// ─── Step 1: Expired JSONL ───────────────────────────────────────────────────

async function reclaimExpiredJsonl(
  dataRoot: string,
  agentDirs: string[],
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let deleted = 0;

  // Scan dataRoot for root-level offload-*.jsonl (legacy layout)
  deleted += await deleteExpiredJsonlInDir(dataRoot, cutoffMs, logger);

  // Scan each agent directory
  for (const dir of agentDirs) {
    deleted += await deleteExpiredJsonlInDir(dir, cutoffMs, logger);
  }

  return deleted;
}

async function deleteExpiredJsonlInDir(
  dir: string,
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  if (!(await isPlainDirectory(dir))) return 0;
  let deleted = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }

  const jsonlFiles = entries.filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"));
  for (const file of jsonlFiles) {
    const filePath = join(dir, file);
    try {
      const s = await lstat(filePath);
      if (s.isFile() && s.mtimeMs < cutoffMs) {
        await unlink(filePath);
        deleted++;
        logger.debug?.(`${TAG} Step 1: deleted expired JSONL: ${filePath} (mtime=${new Date(s.mtimeMs).toISOString()})`);
      }
    } catch (err) {
      logger.warn(`${TAG} Step 1: failed to process ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sync-clean sessions-registry.json: remove entries whose offloadFile was deleted
  if (deleted > 0) {
    await syncRegistryAfterJsonlDeletion(dir, logger);
  }

  return deleted;
}

/** Remove registry entries whose offloadFile no longer exists on disk. */
async function syncRegistryAfterJsonlDeletion(dir: string, logger: PluginLogger): Promise<void> {
  const registryPath = join(dir, "sessions-registry.json");
  if (!(await isRegularFile(registryPath))) return;
  try {
    const raw = await readFile(registryPath, "utf-8");
    const registry = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    let changed = false;
    for (const [key, val] of Object.entries(registry)) {
      const offloadFile = val.offloadFile as string | undefined;
      if (offloadFile && !existsSync(join(dir, offloadFile))) {
        delete registry[key];
        changed = true;
      }
    }
    if (changed) {
      await atomicWriteJson(registryPath, registry);
    }
  } catch {
    /* best-effort */
  }
}

// ─── Step 2: Orphan refs ─────────────────────────────────────────────────────

async function reclaimOrphanRefs(
  agentDirs: string[],
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let deleted = 0;

  for (const agentDir of agentDirs) {
    const refsDir = join(agentDir, "refs");
    if (!(await isPlainDirectory(agentDir)) || !(await isPlainDirectory(refsDir))) continue;

    // Build set of referenced ref filenames from surviving JSONL files
    let referencedRefs: Set<string> | null = null;
    try {
      referencedRefs = await buildReferencedRefSet(agentDir);
    } catch {
      // Incomplete evidence cannot establish that an old ref is an orphan.
      logger.warn(`${TAG} Step 2: reference evidence unavailable, skipping ref reclamation`);
      continue;
    }

    let refFiles: string[];
    try {
      refFiles = (await readdir(refsDir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const file of refFiles) {
      const filePath = join(refsDir, file);
      try {
        const isReferenced = referencedRefs !== null && referencedRefs.has(file);
        if (isReferenced) continue;

        // Proven unreferenced in the readable index — check mtime
        const s = await lstat(filePath);
        if (s.isFile() && s.mtimeMs < cutoffMs) {
          await unlink(filePath);
          deleted++;
          logger.debug?.(`${TAG} Step 2: deleted orphan ref: ${filePath}`);
        }
      } catch {
        /* skip individual file errors */
      }
    }
  }

  return deleted;
}

/** Parse all offload-*.jsonl in an agent dir, collect referenced ref filenames. */
async function buildReferencedRefSet(agentDir: string): Promise<Set<string>> {
  const refs = new Set<string>();
  const files = await readdir(agentDir);
  const jsonlFiles = files.filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"));
  for (const file of jsonlFiles) {
    const filePath = join(agentDir, file);
    if (!(await isRegularFile(filePath))) throw new Error("Reference evidence unavailable");
    const content = await readFile(filePath, "utf-8");
    // Do not repair/skip malformed lines when authorizing destructive cleanup.
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Reference evidence invalid");
      }
      const resultRef = (entry as Record<string, unknown>).result_ref;
      if (typeof resultRef !== "string") throw new Error("Reference evidence invalid");
      if (resultRef.length > 0) refs.add(basename(resultRef));
    }
  }

  return refs;
}

// ─── Step 3: Expired MMDs ────────────────────────────────────────────────────

/** Minimum number of MMD files to keep per agent, regardless of age. */
const MIN_KEEP_MMDS = 15;

async function reclaimExpiredMmds(
  agentDirs: string[],
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let deleted = 0;

  for (const agentDir of agentDirs) {
    const mmdsDir = join(agentDir, "mmds");
    if (!(await isPlainDirectory(agentDir)) || !(await isPlainDirectory(mmdsDir))) continue;

    // Read activeMmdFile from state.json to protect it
    let activeMmdFile: string | null = null;
    try {
      const stateFile = join(agentDir, "state.json");
      if (!(await isRegularFile(stateFile))) continue;
      const state: unknown = JSON.parse(await readFile(stateFile, "utf-8"));
      if (!state || typeof state !== "object" || Array.isArray(state)) continue;
      const active = (state as Record<string, unknown>).activeMmdFile;
      if (active !== null && (typeof active !== "string" || !active || basename(active) !== active)) continue;
      activeMmdFile = active;
    } catch {
      // Missing, unreadable or malformed state cannot authorize MMD deletion.
      continue;
    }

    let mmdFiles: string[];
    try {
      mmdFiles = (await readdir(mmdsDir)).filter((f) => f.endsWith(".mmd"));
    } catch {
      continue;
    }

    // If total count <= MIN_KEEP_MMDS, nothing to delete
    if (mmdFiles.length <= MIN_KEEP_MMDS) continue;

    // Stat all files to get mtime, then sort oldest-first
    const fileMetas: Array<{ name: string; mtimeMs: number }> = [];
    for (const file of mmdFiles) {
      try {
        const s = await lstat(join(mmdsDir, file));
        if (s.isFile()) fileMetas.push({ name: file, mtimeMs: s.mtimeMs });
      } catch {
        /* skip unstat-able files */
      }
    }
    fileMetas.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    // Walk oldest-first, delete expired ones but stop when we'd drop below MIN_KEEP_MMDS
    let remaining = fileMetas.length;
    for (const meta of fileMetas) {
      if (remaining <= MIN_KEEP_MMDS) break;
      if (meta.name === activeMmdFile) continue; // never delete active MMD
      if (meta.mtimeMs >= cutoffMs) continue;    // not expired

      const filePath = join(mmdsDir, meta.name);
      try {
        await unlink(filePath);
        deleted++;
        remaining--;
        logger.debug?.(`${TAG} Step 3: deleted expired MMD: ${filePath}`);
      } catch {
        /* skip */
      }
    }
  }

  return deleted;
}

// ─── Step 4: Log rotation ────────────────────────────────────────────────────

async function rotateDebugLogs(
  dataRoot: string,
  logMaxSizeMb: number,
  logger: PluginLogger,
): Promise<number> {
  if (logMaxSizeMb <= 0) return 0;

  const maxBytes = logMaxSizeMb * 1024 * 1024;
  let entries: string[];
  try {
    entries = await readdir(dataRoot);
  } catch {
    return 0;
  }

  // Collect *.log and debug *.jsonl files (NOT offload-*.jsonl which are data)
  const logFiles: Array<{ name: string; path: string; size: number }> = [];
  for (const name of entries) {
    const isLog = name.endsWith(".log");
    const isDebugJsonl = name.endsWith(".jsonl") && !name.startsWith("offload-");
    if (!isLog && !isDebugJsonl) continue;

    const filePath = join(dataRoot, name);
    try {
      const s = await lstat(filePath);
      if (s.isFile()) {
        logFiles.push({ name, path: filePath, size: s.size });
      }
    } catch {
      /* skip */
    }
  }

  let totalSize = logFiles.reduce((sum, f) => sum + f.size, 0);
  if (totalSize <= maxBytes) return 0;

  // Sort by size descending — truncate largest first
  logFiles.sort((a, b) => b.size - a.size);

  let truncated = 0;
  for (const file of logFiles) {
    if (totalSize <= maxBytes) break;
    if (file.size === 0) continue;

    try {
      await truncate(file.path, 0);
      totalSize -= file.size;
      truncated++;
      logger.debug?.(`${TAG} Step 4: truncated log: ${file.path} (was ${file.size} bytes)`);
    } catch (err) {
      logger.warn(`${TAG} Step 4: failed to truncate ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return truncated;
}

// ─── Step 5: Registry pruning ────────────────────────────────────────────────

async function pruneRegistries(
  agentDirs: string[],
  cutoffMs: number,
  logger: PluginLogger,
): Promise<number> {
  let pruned = 0;

  for (const agentDir of agentDirs) {
    if (!(await isPlainDirectory(agentDir))) continue;
    const registryPath = join(agentDir, "sessions-registry.json");
    if (!(await isRegularFile(registryPath))) continue;

    try {
      const raw = await readFile(registryPath, "utf-8");
      const registry = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      const originalCount = Object.keys(registry).length;
      let changed = false;

      for (const [key, val] of Object.entries(registry)) {
        const updatedAt = val.updatedAt;
        if (typeof updatedAt !== "string") continue;
        const updatedMs = new Date(updatedAt).getTime();
        if (Number.isNaN(updatedMs)) continue;
        if (updatedMs < cutoffMs) {
          delete registry[key];
          changed = true;
        }
      }

      if (changed) {
        const removedCount = originalCount - Object.keys(registry).length;
        pruned += removedCount;
        await atomicWriteJson(registryPath, registry);
        logger.debug?.(`${TAG} Step 5: pruned ${removedCount} expired entries from ${registryPath}`);
      }
    } catch (err) {
      logger.warn(`${TAG} Step 5: failed to prune ${registryPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return pruned;
}

// ============================
// Helpers
// ============================

/** Atomic JSON write: write to tmp file, then rename into place. */
async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmp = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, filePath);
}
