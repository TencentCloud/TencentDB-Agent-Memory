/**
 * Consolidation checkpoint (wave tdai-memory-subagents-2026-08-02, P6).
 *
 * Dedicated file `dataDir/.metadata/consolidation_checkpoint.json` — DELIBERATELY
 * separate from `recall_checkpoint.json` (owned by CheckpointManager,
 * checkpoint.ts). Holds:
 *
 *   - `lastRunAt` — ISO timestamp of the last successful consolidation run
 *   - `l0Cursor`  — ISO cursor: max `l0_conversations.recorded_at` seen at the
 *                   last run (cursor query over idx_l0_recorded, §5.7)
 *   - `l0Count`   — L0 rows no later than the cursor, RECOMPUTED at each
 *                   finalization (it falls after a TTL sweep, by design)
 *   - `roles`     — per-role progress (memory-keeper etc.)
 *
 * Concurrency: own per-file async lock (same pattern as CheckpointManager but
 * keyed independently — the two checkpoints never share a lock). Writes are
 * atomic (tmp + rename) so a crash cannot corrupt the file. Restored on
 * gateway start by the orchestrator.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { withCheckpointLock } from "./checkpoint-lock.js";

export const CONSOLIDATION_CHECKPOINT_FILENAME =
  "consolidation_checkpoint.json";

/** Per-role progress recorded after each successful run. */
export interface RoleProgress {
  /** ISO timestamp of the last successful run for this role. */
  lastRunAt: string;
  /** Records presented in the diff (processed by the keeper). */
  recordsProcessed: number;
  /** Over-limit scene/persona files listed in the diff (metadata only). */
  overLimitBlocks: number;
  /** Merged duplicate clusters applied. */
  merges: number;
  /** Rewritten scene/persona files applied. */
  rewrites: number;
  /** Errors observed during the run (0 = clean). */
  errors: number;
  /** Failed runs since the last successful one — bounded by the role's
   * `retry_budget` so a broken role stops re-spawning every tick. */
  consecutiveFailures?: number;
  /** ISO timestamp of the last failed run (the budget resets on a new day). */
  lastFailureAt?: string;
}

export interface ConsolidationCheckpointData {
  /** ISO timestamp of the last successful consolidation run ("" = never). */
  lastRunAt: string;
  /** ISO cursor: max l0_conversations.recorded_at at the last run ("" = none). */
  l0Cursor: string;
  /**
   * Second half of the cursor: the `record_id` of the row that produced
   * `l0Cursor` ("" = unknown). 83% of the live rows share their timestamp with
   * a neighbour, so a timestamp alone cannot say where the last run stopped:
   * `>=` re-reads the boundary row forever, `>` drops the partner of a pair
   * split by the batch cap. The pair is unique (`record_id TEXT PRIMARY KEY`)
   * and therefore orders strictly. Additive: a checkpoint written before
   * tz-03a has no such key, reads back as "" and falls back to the old
   * timestamp-only behaviour.
   */
  l0CursorId: string;
  /**
   * Saved L0 rows with a non-empty `recorded_at` no later than the cursor
   * PAIR — recomputed from the store at every finalization (ТЗ A2/A2a), not
   * accumulated. It therefore FALLS after a TTL sweep, which is the point:
   * the old cumulative value could only grow and drifted away from the store
   * without a word.
   */
  l0Count: number;
  /** Per-role progress. */
  roles: Record<string, RoleProgress>;
}

const DEFAULT_CHECKPOINT: ConsolidationCheckpointData = {
  lastRunAt: "",
  l0Cursor: "",
  l0CursorId: "",
  l0Count: 0,
  roles: {},
};

// ============================
// Per-file async lock (independent of CheckpointManager's lock map)
// ============================

const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize async critical sections per file path. Multiple instances sharing
 * the same path automatically share the same lock.
 */
async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  fileLocks.set(filePath, gate);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(filePath) === gate) {
      fileLocks.delete(filePath);
    }
  }
}

// ============================
// ConsolidationCheckpoint
// ============================

export class ConsolidationCheckpoint {
  private readonly filePath: string;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = path.join(
      dataDir,
      ".metadata",
      CONSOLIDATION_CHECKPOINT_FILENAME,
    );
  }

  /** Absolute path of the checkpoint file (for diagnostics/tests). */
  get file(): string {
    return this.filePath;
  }

  /** Unlocked snapshot read. Corrupt/missing file → defaults (fresh start). */
  async read(): Promise<ConsolidationCheckpointData> {
    return withFileLock(this.filePath, async () => this.readRaw());
  }

  /** Full write under the lock, atomic tmp+rename. */
  async write(data: ConsolidationCheckpointData): Promise<void> {
    return withFileLock(this.filePath, () => this.writeRaw(data));
  }

  /**
   * Locked read-modify-write. `mutate` may modify the snapshot in place; the
   * result is persisted atomically. Always used for updates so concurrent
   * runs cannot clobber each other's progress.
   */
  async update(
    mutate: (data: ConsolidationCheckpointData) => void,
  ): Promise<ConsolidationCheckpointData> {
    // Two locks, two different scopes. The hard-link lock keeps OTHER
    // PROCESSES out (the map below is per-process, so without it two gateways
    // both read their own snapshot and both rename over each other — one run
    // simply disappears). The map then keeps this process's own concurrent
    // updates ordered, without touching the filesystem for each of them.
    return withCheckpointLock(this.dataDir, () =>
      withFileLock(this.filePath, async () => {
        const data = await this.readRaw();
        mutate(data);
        await this.writeRaw(data);
        return data;
      }),
    );
  }

  // ============================
  // Low-level I/O
  // ============================

  private async readRaw(): Promise<ConsolidationCheckpointData> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : "",
        l0Cursor: typeof parsed.l0Cursor === "string" ? parsed.l0Cursor : "",
        l0CursorId:
          typeof parsed.l0CursorId === "string" ? parsed.l0CursorId : "",
        l0Count:
          typeof parsed.l0Count === "number" && Number.isFinite(parsed.l0Count)
            ? parsed.l0Count
            : 0,
        roles:
          parsed.roles && typeof parsed.roles === "object"
            ? (parsed.roles as Record<string, RoleProgress>)
            : {},
      };
    } catch {
      // Missing or malformed file — fresh start (same posture as CheckpointManager).
      return { ...DEFAULT_CHECKPOINT, roles: {} };
    }
  }

  private async writeRaw(data: ConsolidationCheckpointData): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }
}
