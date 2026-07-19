import fs from "node:fs/promises";
import path from "node:path";

import type { IMemoryStore } from "../core/store/types.js";
import { ManagedTimer } from "./managed-timer.js";
import type { Logger } from "../core/types.js";
import { formatLocalDateTime, startOfLocalDay } from "./time.js";
import { CheckpointManager } from "./checkpoint.js";

export interface MemoryCleanerOptions {
  baseDir: string;
  retentionDays: number;
  cleanTime: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  /**
   * Optional CheckpointManager used to reconcile global counters after cleanup.
   * When provided, {@link LocalMemoryCleaner.runOnce} will recalculate
   * `total_processed`, `total_memories_extracted`, and `scenes_processed`
   * against authoritative sources (vectorStore counts + scene_blocks file count)
   * after the deletion pass, fixing the counter-drift issue (#157).
   *
   * If absent, cleanup proceeds but counters are NOT recalculated (legacy behavior).
   */
  checkpointManager?: CheckpointManager;
}

interface CleanupStats {
  scannedFiles: number;
  changedFiles: number;
  skippedNonShardFiles: number;
  deleteFailedFiles: number;
}

const TAG = "[memory-tdai][cleaner]";
const L0_DIR_NAME = "conversations";
const L1_DIR_NAME = "records";

/** Minimum records to retain — skip deletion if total is at or below this threshold. */
const MIN_RETAIN_L0 = 50;
const MIN_RETAIN_L1 = 20;

export class LocalMemoryCleaner {
  private readonly timer: ManagedTimer;
  private destroyed = false;
  private vectorStore?: IMemoryStore;
  private checkpointManager?: CheckpointManager;

  constructor(private readonly opts: MemoryCleanerOptions) {
    this.timer = new ManagedTimer("memory-tdai-cleaner", () => this.destroyed);
    this.vectorStore = opts.vectorStore;
    this.checkpointManager = opts.checkpointManager;
  }

  setVectorStore(vectorStore: IMemoryStore | undefined): void {
    this.vectorStore = vectorStore;
  }

  /**
   * Inject (or replace) the CheckpointManager used for post-cleanup counter
   * reconciliation. Mirrors the {@link setVectorStore} pattern so callers can
   * wire the checkpoint after async store init completes.
   */
  setCheckpointManager(cm: CheckpointManager | undefined): void {
    this.checkpointManager = cm;
  }

  start(): void {
    if (this.destroyed) return;

    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const utcOffset = formatUtcOffset(-now.getTimezoneOffset());

    this.opts.logger?.debug?.(
      `${TAG} Enabled: retentionDays=${this.opts.retentionDays}, cleanTime=${this.opts.cleanTime}, dirs=[${L0_DIR_NAME}, ${L1_DIR_NAME}]`,
    );
    this.opts.logger?.debug?.(
      `${TAG} Runtime clock: nowLocal=${formatLocalDateTime(now)}, nowIso=${now.toISOString()}, tz=${tz}, utcOffset=${utcOffset}`,
    );

    this.scheduleNext();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.timer.cancel();
    this.opts.logger?.info(`${TAG} Stopped`);
  }

  async runOnce(nowMs = Date.now()): Promise<void> {
    if (this.destroyed) return;

    const retentionDays = this.opts.retentionDays;
    if (!(retentionDays > 0)) {
      this.opts.logger?.debug?.(`${TAG} Skip run: invalid retentionDays=${retentionDays}`);
      return;
    }

    // 按"本地自然日"保留策略计算截止时间。
    // 例如 retentionDays=2，今天是 03-15，则保留 03-14/03-15，删除早于 03-14 00:00:00.000 的记录。
    let cutoffMs: number;
    try {
      cutoffMs = computeCutoffMsByLocalDay(nowMs, retentionDays);
    } catch (err) {
      this.opts.logger?.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const targetDirs = [
      path.join(this.opts.baseDir, L0_DIR_NAME),
      path.join(this.opts.baseDir, L1_DIR_NAME),
    ];

    const total: CleanupStats = {
      scannedFiles: 0,
      changedFiles: 0,
      skippedNonShardFiles: 0,
      deleteFailedFiles: 0,
    };

    for (const dirPath of targetDirs) {
      const stats = await this.cleanDirectory(dirPath, cutoffMs);
      total.scannedFiles += stats.scannedFiles;
      total.changedFiles += stats.changedFiles;
      total.skippedNonShardFiles += stats.skippedNonShardFiles;
      total.deleteFailedFiles += stats.deleteFailedFiles;
    }

    if (this.vectorStore) {
      const vectorStore = this.vectorStore;
      const cutoffIso = new Date(cutoffMs).toISOString();
      const startMs = Date.now();

      // ── Pre-delete: count totals and decide whether to proceed ──
      let totalL0 = 0;
      let totalL1 = 0;
      try { totalL0 = await vectorStore.countL0(); } catch { /* non-fatal */ }
      try { totalL1 = await vectorStore.countL1(); } catch { /* non-fatal */ }

      this.opts.logger?.info(
        `${TAG} [Pre-delete] cutoffIso=${cutoffIso}, retentionDays=${retentionDays}, totalL0=${totalL0}, totalL1=${totalL1}`,
      );

      let removedL0 = 0;
      let removedL1 = 0;
      let skippedL0 = false;
      let skippedL1 = false;
      let failedL0DbCleanup = 0;
      let failedL1DbCleanup = 0;

      // ── L0 cleanup with minimum-retention guard ──
      if (totalL0 <= MIN_RETAIN_L0) {
        skippedL0 = true;
        this.opts.logger?.info(
          `${TAG} [L0-delete] SKIPPED: totalL0=${totalL0} <= minRetain=${MIN_RETAIN_L0}`,
        );
      } else {
        try {
          removedL0 = await vectorStore.deleteL0Expired(cutoffIso);
        } catch (err) {
          failedL0DbCleanup = 1;
          this.opts.logger?.warn(
            `${TAG} [L0-delete] FAILED: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── L1 cleanup with minimum-retention guard ──
      if (totalL1 <= MIN_RETAIN_L1) {
        skippedL1 = true;
        this.opts.logger?.info(
          `${TAG} [L1-delete] SKIPPED: totalL1=${totalL1} <= minRetain=${MIN_RETAIN_L1}`,
        );
      } else {
        try {
          removedL1 = await vectorStore.deleteL1Expired(cutoffIso);
        } catch (err) {
          failedL1DbCleanup = 1;
          this.opts.logger?.warn(
            `${TAG} [L1-delete] FAILED: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (removedL1 > 0 || removedL0 > 0) {
        total.changedFiles += 1;
      }

      // ── Post-delete: audit summary ──
      const durationMs = Date.now() - startMs;
      const remainingL0 = totalL0 - removedL0;
      const remainingL1 = totalL1 - removedL1;
      const summary = {
        event: "cleaner_summary",
        cutoffIso,
        retentionDays,
        l0: { total: totalL0, expired: removedL0, remaining: remainingL0, skipped: skippedL0, failed: failedL0DbCleanup > 0 },
        l1: { total: totalL1, expired: removedL1, remaining: remainingL1, skipped: skippedL1, failed: failedL1DbCleanup > 0 },
        durationMs,
      };
      this.opts.logger?.info(`${TAG} ${JSON.stringify(summary)}`);
    }

    this.opts.logger?.info(
      `${TAG} Cleanup done: scannedFiles=${total.scannedFiles}, changedFiles=${total.changedFiles}, skippedNonShardFiles=${total.skippedNonShardFiles}, deleteFailedFiles=${total.deleteFailedFiles}`,
    );

    // ── Counter reconciliation (issue #157) ──────────────────────────
    // After cleanup, global counters (total_processed, total_memories_extracted,
    // scenes_processed) may have drifted from actual data. Recalculate them
    // against authoritative sources so downstream logic (persona trigger, L2,
    // backup naming) operates on accurate counts.
    //
    // Only the 3 counters with authoritative sources are auto-recalculated:
    //   total_processed         ← vectorStore.countL0()   (L0 message count)
    //   total_memories_extracted ← vectorStore.countL1()  (L1 record count)
    //   scenes_processed        ← fs count of scene_blocks/*.md
    //
    // l0_conversations_count and memories_since_last_persona have no
    // authoritative source and are left for manual recalculate/decrement.
    //
    // NOTE: This is a best-effort snapshot reconciliation. The counts are read
    // outside the checkpoint file lock, so there is an inherent TOCTOU window
    // between the count read and the locked set. Acceptable for a daily cleaner
    // running during quiescent periods.
    await this.reconcileCheckpointCounters();

  }

  /**
   * Recalculate checkpoint counters against authoritative sources after cleanup.
   * No-op if neither checkpointManager nor vectorStore is available.
   */
  private async reconcileCheckpointCounters(): Promise<void> {
    if (!this.checkpointManager) {
      this.opts.logger?.debug?.(`${TAG} Skip counter reconciliation: no checkpointManager`);
      return;
    }

    // Read authoritative counts. countL0/countL1 are best-effort (return 0 on failure).
    let actualL0 = 0;
    let actualL1 = 0;
    if (this.vectorStore) {
      try { actualL0 = await this.vectorStore.countL0(); } catch { /* non-fatal */ }
      try { actualL1 = await this.vectorStore.countL1(); } catch { /* non-fatal */ }
    } else {
      this.opts.logger?.debug?.(`${TAG} Counter reconciliation: no vectorStore, L0/L1 counts default to 0`);
    }

    // Count scene block files (fs-based, no vectorStore dependency).
    let actualScenes = 0;
    try {
      actualScenes = await countSceneBlockFiles(this.opts.baseDir);
    } catch (err) {
      this.opts.logger?.warn?.(
        `${TAG} Failed to count scene_blocks for reconciliation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await this.checkpointManager.recalculateCounters({
        total_processed: actualL0,
        total_memories_extracted: actualL1,
        scenes_processed: actualScenes,
      });
      this.opts.logger?.info?.(
        `${TAG} Counter reconciliation done: total_processed=${actualL0}, total_memories_extracted=${actualL1}, scenes_processed=${actualScenes}`,
      );
    } catch (err) {
      this.opts.logger?.warn?.(
        `${TAG} Counter reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleNext(): void {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const next = nextRunAt(this.opts.cleanTime, nowMs);
    const targetToday = buildTodayRunTime(this.opts.cleanTime, nowMs);
    const passedToday = targetToday <= nowMs;
    const delayMs = Math.max(0, next - nowMs);

    this.opts.logger?.debug?.(
      `${TAG} Schedule next run: nowLocal=${formatLocalDateTime(now)}, cleanTime=${this.opts.cleanTime}, targetTodayLocal=${formatLocalDateTime(new Date(targetToday))}, passedToday=${passedToday}, nextRunLocal=${formatLocalDateTime(new Date(next))}, nextRunIso=${new Date(next).toISOString()}, delayMs=${delayMs}`,
    );

    this.timer.scheduleAt(next, () => {
      const firedAtMs = Date.now();
      this.opts.logger?.info(
        `${TAG} Timer fired: scheduledLocal=${formatLocalDateTime(new Date(next))}, firedLocal=${formatLocalDateTime(new Date(firedAtMs))}, driftMs=${firedAtMs - next}`,
      );
      void this.runAndReschedule();
    });
  }

  private async runAndReschedule(): Promise<void> {
    if (this.destroyed) return;
    const runStart = new Date();
    this.opts.logger?.info(
      `${TAG} Cleanup tick start: nowLocal=${formatLocalDateTime(runStart)}, nowIso=${runStart.toISOString()}`,
    );

    try {
      await this.runOnce();
    } catch (err) {
      this.opts.logger?.error(`${TAG} Cleanup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      if (!this.destroyed) {
        this.scheduleNext();
      }
    }
  }

  private async cleanDirectory(dirPath: string, cutoffMs: number): Promise<CleanupStats> {
    const stats: CleanupStats = {
      scannedFiles: 0,
      changedFiles: 0,
      skippedNonShardFiles: 0,
      deleteFailedFiles: 0,
    };

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {

      this.opts.logger?.debug?.(`${TAG} Directory not found, skip: ${dirPath}`);
      return stats;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!isJsonLikeFile(entry.name)) continue;

      const filePath = path.join(dirPath, entry.name);
      stats.scannedFiles += 1;

      // 仅支持日期分片文件：YYYY-MM-DD(.jsonl/.json)
      const shard = extractShardDateFromFileName(entry.name);
      if (!shard) {
        stats.skippedNonShardFiles += 1;
        this.opts.logger?.debug?.(`${TAG} Skip non-shard file: ${filePath}`);
        continue;
      }

      const dayEndMs = localDayEndMs(shard.year, shard.month, shard.day);
      if (dayEndMs < cutoffMs) {
        try {
          await fs.unlink(filePath);
          stats.changedFiles += 1;
          this.opts.logger?.info(`${TAG} Removed expired file by name: ${filePath}`);
        } catch (err) {
          stats.deleteFailedFiles += 1;
          this.opts.logger?.warn(
            `${TAG} Failed to delete expired shard file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        this.opts.logger?.debug?.(`${TAG} Keep shard file by name: ${filePath}`);
      }
    }

    return stats;
  }
}

function isJsonLikeFile(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".json");
}

function extractShardDateFromFileName(
  fileName: string,
): { year: number; month: number; day: number } | undefined {

  // Supported format: YYYY-MM-DD.jsonl | YYYY-MM-DD.json
  const m = /^(\d{4})-(\d{2})-(\d{2})\.(?:jsonl|json)$/.exec(fileName);
  if (!m) return undefined;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }

  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year
    || probe.getMonth() !== month - 1
    || probe.getDate() !== day
  ) {
    return undefined;
  }

  return { year, month, day };
}

function localDayEndMs(year: number, month: number, day: number): number {
  // End of day = start of next day minus 1ms (in configured timezone)
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDayStartMs = startOfLocalDay(nextDay);
  return nextDayStartMs - 1;
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function computeCutoffMsByLocalDay(nowMs: number, retentionDays: number): number {
  // 自然日策略，保留"今天 + 往前 retentionDays-1 天"
  // 删除阈值为 keepStart 当天 00:00:00.000（配置时区）
  const now = new Date(nowMs);
  const todayStartMs = startOfLocalDay(now);
  const cutoffMs = todayStartMs - (retentionDays - 1) * 24 * 60 * 60 * 1000;

  // Sanity check: cutoff must be strictly in the past
  if (cutoffMs >= nowMs) {
    throw new Error(
      `cutoff sanity failed: cutoff (${cutoffMs}) >= now (${nowMs}), ` +
      `possible clock skew or invalid retentionDays=${retentionDays}`,
    );
  }
  // Sanity check: gap between now and cutoff must be at least 24h
  const MIN_GAP_MS = 24 * 60 * 60 * 1000;
  if (nowMs - cutoffMs < MIN_GAP_MS) {
    throw new Error(
      `cutoff sanity failed: gap ${nowMs - cutoffMs}ms < 24h, ` +
      `retentionDays=${retentionDays}, possible clock skew`,
    );
  }

  return cutoffMs;
}

function buildTodayRunTime(cleanTime: string, nowMs: number): number {

  const [hRaw, mRaw] = cleanTime.split(":");
  const hour = Number(hRaw);
  const minute = Number(mRaw);

  const target = new Date(nowMs);
  target.setHours(hour, minute, 0, 0);
  return target.getTime();
}

function nextRunAt(cleanTime: string, nowMs: number): number {

  const [hRaw, mRaw] = cleanTime.split(":");
  const hour = Number(hRaw);
  const minute = Number(mRaw);

  const now = new Date(nowMs);
  const next = new Date(nowMs);
  next.setHours(hour, minute, 0, 0);

  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime();
}

/**
 * Count `.md` scene block files in `<baseDir>/scene_blocks/`.
 * Used as the authoritative source for `scenes_processed` during reconciliation.
 * Returns 0 if the directory does not exist.
 */
async function countSceneBlockFiles(baseDir: string): Promise<number> {
  const blocksDir = path.join(baseDir, "scene_blocks");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(blocksDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".md")) count += 1;
  }
  return count;
}
