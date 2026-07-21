/**
 * Checkpoint management for tracking memory processing progress.
 *
 * ## Split-state design
 *
 * Per-session state is split into two independent namespaces to prevent
 * the PipelineManager and L0/L1 runners from overwriting each other's fields:
 *
 * - **runner_states** (`RunnerSessionState`): owned by CheckpointManager methods
 *   (markL1*, advanceSession*). Contains L0 capture cursor, L1 cursor, scene name.
 *
 * - **pipeline_states** (`PipelineSessionState`): owned exclusively by
 *   PipelineManager via `mergePipelineStates()`. Contains conversation_count,
 *   extraction times, L2 tracking fields.
 *
 * Each side only reads/writes its own namespace, eliminating the split-brain
 * overwrite bug where pipeline persistStates() could clobber runner-written fields.
 *
 * ## Concurrency safety
 *
 * All mutating methods (read-modify-write) are serialized via a per-file async lock.
 * Multiple CheckpointManager instances sharing the same file path automatically share
 * the same lock, so callers can freely `new CheckpointManager()` without coordination.
 * Writes use atomic tmp+rename to prevent corruption on crash.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ============================
// Types
// ============================

export interface RunnerSessionState {
  last_captured_timestamp: number;
  last_l1_cursor: number;
  last_scene_name: string;
}

export interface PipelineSessionState {
  conversation_count: number;
  last_extraction_time: string;
  last_extraction_updated_time: string;
  last_active_time: number;
  l2_pending_l1_count: number;
  warmup_threshold: number;
  l2_last_extraction_time: string;
}

export interface Checkpoint {
  last_captured_timestamp: number;
  total_processed: number;
  last_persona_at: number;
  last_persona_time: string;
  request_persona_update: boolean;
  persona_update_reason: string;
  memories_since_last_persona: number;
  scenes_processed: number;
  runner_states: Record<string, RunnerSessionState>;
  pipeline_states: Record<string, PipelineSessionState>;
  l0_conversations_count: number;
  total_memories_extracted: number;
}

const DEFAULT_RUNNER_STATE: RunnerSessionState = {
  last_captured_timestamp: 0,
  last_l1_cursor: 0,
  last_scene_name: "",
};

const DEFAULT_PIPELINE_STATE: PipelineSessionState = {
  conversation_count: 0,
  last_extraction_time: "",
  last_extraction_updated_time: "",
  last_active_time: 0,
  l2_pending_l1_count: 0,
  warmup_threshold: 0,
  l2_last_extraction_time: "",
};

const DEFAULT_CHECKPOINT: Checkpoint = {
  last_captured_timestamp: 0,
  total_processed: 0,
  last_persona_at: 0,
  last_persona_time: "",
  request_persona_update: false,
  persona_update_reason: "",
  memories_since_last_persona: 0,
  scenes_processed: 0,
  runner_states: {},
  pipeline_states: {},
  l0_conversations_count: 0,
  total_memories_extracted: 0,
};

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
}

/**
 * Minimal view of the memory store needed for recalibration.
 */
export interface RecalibrationSource {
  countL0(): number | Promise<number>;
  countL1(): number | Promise<number>;
}

export interface RecalibrateOptions {
  /** Live-count provider (typically the vector store). */
  source?: RecalibrationSource;
  /** Explicit L0 count. */
  l0Count?: number;
  /** Explicit L1 count. */
  l1Count?: number;
  /** When true, count JSONL files on disk (degraded mode). */
  useJsonlFallback?: boolean;
  /** Authoritative total_processed message count. */
  totalProcessedCount?: number;
  /** Authoritative memories_since_last_persona count. */
  memoriesSincePersonaCount?: number;
  /** Clamp stale per-session L1 cursors to this timestamp. */
  earliestValidL0Timestamp?: number;
}

export interface RecalibrationResult {
  l0Changed: boolean;
  l1Changed: boolean;
  totalProcessedChanged: boolean;
  memoriesSincePersonaChanged: boolean;
  cursorsRolledBack: number;
  /** Data source used: "store" | "jsonl" | "manual". */
  source: "store" | "jsonl" | "manual";
  before: {
    l0Count: number;
    l1Count: number;
    totalProcessed: number;
    memoriesSincePersona: number;
  };
  after: {
    l0Count: number;
    l1Count: number;
    totalProcessed: number;
    memoriesSincePersona: number;
  };
}

const noopLogger: CheckpointLogger = { info() {} };

/** Clamp a count to a safe non-negative integer. NaN/Infinity/negative → 0. */
function clampCount(v: number): number {
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

// ============================
// Per-file async lock
// ============================

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
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

export class CheckpointManager {
  private filePath: string;
  private logger: CheckpointLogger;

  constructor(dataDir: string, logger?: CheckpointLogger) {
    this.filePath = path.join(dataDir, ".metadata", "recall_checkpoint.json");
    this.logger = logger ?? noopLogger;
  }

  private async readRaw(): Promise<Checkpoint> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const cp = { ...structuredClone(DEFAULT_CHECKPOINT), ...parsed } as Checkpoint;
      const oldStates = parsed.session_states as Record<string, Record<string, unknown>> | undefined;
      if (oldStates && !parsed.runner_states && !parsed.pipeline_states) {
        cp.runner_states = {};
        cp.pipeline_states = {};
        for (const [key, state] of Object.entries(oldStates)) {
          cp.runner_states[key] = {
            ...DEFAULT_RUNNER_STATE,
            last_captured_timestamp: (state.last_captured_timestamp as number) ?? 0,
            last_l1_cursor: (state.last_l1_cursor as number) ?? 0,
            last_scene_name: (state.last_scene_name as string) ?? "",
          };
          cp.pipeline_states[key] = {
            ...DEFAULT_PIPELINE_STATE,
            conversation_count: (state.conversation_count as number) ?? 0,
            last_extraction_time: (state.last_extraction_time as string) ?? "",
            last_extraction_updated_time: (state.last_extraction_updated_time as string) ?? "",
            last_active_time: (state.last_active_time as number) ?? 0,
            l2_pending_l1_count: (state.l2_pending_l1_count as number) ?? 0,
            l2_last_extraction_time: (state.l2_last_extraction_time as string) ?? "",
          };
        }
      } else {
        if (cp.runner_states) {
          for (const [key, state] of Object.entries(cp.runner_states)) {
            cp.runner_states[key] = { ...DEFAULT_RUNNER_STATE, ...state };
          }
        }
        if (cp.pipeline_states) {
          for (const [key, state] of Object.entries(cp.pipeline_states)) {
            cp.pipeline_states[key] = { ...DEFAULT_PIPELINE_STATE, ...state };
          }
        }
      }
      return cp;
    } catch {
      return structuredClone(DEFAULT_CHECKPOINT);
    }
  }

  private async writeRaw(checkpoint: Checkpoint): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }

  private async mutate(fn: (cp: Checkpoint) => void | Promise<void>): Promise<Checkpoint> {
    return withFileLock(this.filePath, async () => {
      const cp = await this.readRaw();
      await fn(cp);
      await this.writeRaw(cp);
      return cp;
    });
  }

  async read(): Promise<Checkpoint> {
    return this.readRaw();
  }

  async write(checkpoint: Checkpoint): Promise<void> {
    return withFileLock(this.filePath, () => this.writeRaw(checkpoint));
  }

  async markPersonaGenerated(totalProcessed: number): Promise<void> {
    await this.mutate((cp) => {
      cp.last_persona_at = totalProcessed;
      cp.last_persona_time = new Date().toISOString();
      cp.memories_since_last_persona = 0;
      cp.request_persona_update = false;
      cp.persona_update_reason = "";
    });
  }

  async clearPersonaRequest(): Promise<void> {
    await this.mutate((cp) => {
      cp.request_persona_update = false;
      cp.persona_update_reason = "";
    });
  }

  async setPersonaUpdateRequest(reason: string): Promise<void> {
    await this.mutate((cp) => {
      cp.request_persona_update = true;
      cp.persona_update_reason = reason;
    });
  }

  async incrementScenesProcessed(): Promise<void> {
    const cp = await this.mutate((cp) => { cp.scenes_processed += 1; });
    this.logger.info(`[checkpoint] incrementScenesProcessed: scenes_processed=${cp.scenes_processed}`);
  }

  getRunnerState(cp: Checkpoint, sessionKey: string): RunnerSessionState {
    if (!cp.runner_states) cp.runner_states = {};
    let state = cp.runner_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_RUNNER_STATE };
      cp.runner_states[sessionKey] = state;
    }
    return state;
  }

  getPipelineState(cp: Checkpoint, sessionKey: string): PipelineSessionState {
    if (!cp.pipeline_states) cp.pipeline_states = {};
    let state = cp.pipeline_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_PIPELINE_STATE, last_active_time: Date.now() };
      cp.pipeline_states[sessionKey] = state;
    }
    return state;
  }

  getAllPipelineStates(cp: Checkpoint): Record<string, PipelineSessionState> {
    return cp.pipeline_states ?? {};
  }

  async mergePipelineStates(states: Record<string, PipelineSessionState>): Promise<void> {
    await this.mutate((cp) => {
      if (!cp.pipeline_states) cp.pipeline_states = {};
      for (const [key, pState] of Object.entries(states)) {
        cp.pipeline_states[key] = { ...cp.pipeline_states[key], ...pState };
      }
    });
  }

  async markL1ExtractionComplete(
    sessionKey: string,
    memoriesExtracted: number,
    cursorRecordedAtMs?: number,
    lastSceneName?: string,
  ): Promise<void> {
    await this.mutate((cp) => {
      const state = this.getRunnerState(cp, sessionKey);
      if (cursorRecordedAtMs) state.last_l1_cursor = cursorRecordedAtMs;
      if (lastSceneName !== undefined) state.last_scene_name = lastSceneName;
      cp.total_memories_extracted += memoriesExtracted;
      cp.memories_since_last_persona += memoriesExtracted;
    });
    this.logger.info(
      `[checkpoint] markL1ExtractionComplete session=${sessionKey}: ` +
      `extracted=${memoriesExtracted}, cursor=${cursorRecordedAtMs ?? "(unchanged)"}, ` +
      `lastScene="${lastSceneName ?? "(unchanged)"}"`,
    );
  }

  async captureAtomically(
    sessionKey: string,
    pluginStartTimestamp: number | undefined,
    fn: (afterTimestamp: number) => Promise<{ maxTimestamp: number; messageCount: number } | null>,
  ): Promise<void> {
    await this.mutate(async (cp) => {
      const state = this.getRunnerState(cp, sessionKey);
      let afterTimestamp = state.last_captured_timestamp || 0;
      if (afterTimestamp === 0 && pluginStartTimestamp && pluginStartTimestamp > 0) {
        afterTimestamp = pluginStartTimestamp;
      }
      const result = await fn(afterTimestamp);
      if (result) {
        state.last_captured_timestamp = result.maxTimestamp;
        cp.last_captured_timestamp = Math.max(cp.last_captured_timestamp, result.maxTimestamp);
        cp.total_processed += result.messageCount;
        cp.l0_conversations_count += 1;
      }
    });
  }

  // ============================
  // Counter recalibration (drift fix after cleanup — Issue #157)
  // ============================

  /**
   * Recalibrate cumulative counters (and optionally per-session cursors)
   * to match ground truth.
   *
   * ## Source resolution order:
   * 1. `opts.source` — live store counts (authoritative)
   * 2. `opts.l0Count` / `opts.l1Count` — explicit values
   * 3. `opts.useJsonlFallback` — disk JSONL counting (degraded mode)
   * 4. None of the above — no-op
   *
   * All count values are defensively clamped: NaN, negative, and non-finite
   * values are replaced with 0. Count resolution happens OUTSIDE the lock.
   */
  async recalibrate(opts: RecalibrateOptions = {}): Promise<RecalibrationResult> {
    const { source, l0Count: explicitL0, l1Count: explicitL1, totalProcessedCount, memoriesSincePersonaCount, earliestValidL0Timestamp, useJsonlFallback } = opts;

    let resolvedL0: number | undefined;
    let resolvedL1: number | undefined;
    let usedSource: "store" | "jsonl" | "manual";

    if (source) {
      resolvedL0 = clampCount(await source.countL0());
      resolvedL1 = clampCount(await source.countL1());
      usedSource = "store";
    } else if (explicitL0 !== undefined || explicitL1 !== undefined) {
      resolvedL0 = explicitL0 !== undefined ? clampCount(explicitL0) : undefined;
      resolvedL1 = explicitL1 !== undefined ? clampCount(explicitL1) : undefined;
      usedSource = "manual";
    } else if (useJsonlFallback) {
      resolvedL0 = await this.countJsonlLines("conversations");
      resolvedL1 = await this.countJsonlLines("records");
      usedSource = "jsonl";
    } else {
      usedSource = "manual";
    }

    const safeTotalProcessed = totalProcessedCount !== undefined ? clampCount(totalProcessedCount) : undefined;
    const safeMemoriesSincePersona = memoriesSincePersonaCount !== undefined ? clampCount(memoriesSincePersonaCount) : undefined;

    const result: RecalibrationResult = {
      l0Changed: false, l1Changed: false, totalProcessedChanged: false, memoriesSincePersonaChanged: false,
      cursorsRolledBack: 0, source: usedSource,
      before: { l0Count: 0, l1Count: 0, totalProcessed: 0, memoriesSincePersona: 0 },
      after: { l0Count: 0, l1Count: 0, totalProcessed: 0, memoriesSincePersona: 0 },
    };

    // Fast-path: nothing to do
    if (
      usedSource === "manual" && resolvedL0 === undefined && resolvedL1 === undefined &&
      safeTotalProcessed === undefined && safeMemoriesSincePersona === undefined &&
      earliestValidL0Timestamp === undefined
    ) {
      const cp = await this.read();
      result.before = { l0Count: cp.l0_conversations_count, l1Count: cp.total_memories_extracted, totalProcessed: cp.total_processed, memoriesSincePersona: cp.memories_since_last_persona };
      result.after = { ...result.before };
      return result;
    }

    await this.mutate((cp) => {
      result.before = { l0Count: cp.l0_conversations_count, l1Count: cp.total_memories_extracted, totalProcessed: cp.total_processed, memoriesSincePersona: cp.memories_since_last_persona };

      if (resolvedL0 !== undefined && resolvedL0 !== cp.l0_conversations_count) {
        this.logger.info(`[checkpoint] recalibrate l0_conversations_count: ${cp.l0_conversations_count} → ${resolvedL0}`);
        cp.l0_conversations_count = resolvedL0;
        result.l0Changed = true;
      }
      if (resolvedL1 !== undefined && resolvedL1 !== cp.total_memories_extracted) {
        this.logger.info(`[checkpoint] recalibrate total_memories_extracted: ${cp.total_memories_extracted} → ${resolvedL1}`);
        cp.total_memories_extracted = resolvedL1;
        result.l1Changed = true;
      }
      // total_processed counter 修正
      if (safeTotalProcessed !== undefined && safeTotalProcessed !== cp.total_processed) {
        this.logger.info(`[checkpoint] recalibrate total_processed: ${cp.total_processed} → ${safeTotalProcessed}`);
        cp.total_processed = safeTotalProcessed;
        result.totalProcessedChanged = true;
      }
      if (safeMemoriesSincePersona !== undefined && safeMemoriesSincePersona !== cp.memories_since_last_persona) {
        this.logger.info(`[checkpoint] recalibrate memories_since_last_persona: ${cp.memories_since_last_persona} → ${safeMemoriesSincePersona}`);
        cp.memories_since_last_persona = safeMemoriesSincePersona;
        result.memoriesSincePersonaChanged = true;
      }

      // Cursor rollback
      if (earliestValidL0Timestamp !== undefined && cp.runner_states) {
        for (const state of Object.values(cp.runner_states)) {
          if (state.last_l1_cursor > 0 && state.last_l1_cursor < earliestValidL0Timestamp) {
            this.logger.info(`[checkpoint] recalibrate cursor rollback: last_l1_cursor ${state.last_l1_cursor} → ${earliestValidL0Timestamp}`);
            state.last_l1_cursor = earliestValidL0Timestamp;
            result.cursorsRolledBack += 1;
          }
        }
      }

      result.after = { l0Count: cp.l0_conversations_count, l1Count: cp.total_memories_extracted, totalProcessed: cp.total_processed, memoriesSincePersona: cp.memories_since_last_persona };
    });

    return result;
  }

  /**
   * Count non-empty lines across YYYY-MM-DD.jsonl daily shards in a
   * subdirectory of dataDir. Used as the degraded-mode fallback.
   */
  private async countJsonlLines(subDir: string): Promise<number> {
    const dirPath = path.join(path.dirname(path.dirname(this.filePath)), subDir);
    const shardPattern = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
    let entries: Array<{ name: string; isFile(): boolean }>;
    try {
      const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
      entries = dirEntries.filter((e) => e.isFile() && shardPattern.test(e.name));
    } catch { return 0; }
    let total = 0;
    for (const entry of entries) {
      try {
        const raw = await fs.readFile(path.join(dirPath, entry.name), "utf-8");
        for (const line of raw.split("\n")) { if (line.trim()) total += 1; }
      } catch (err) {
        this.logger.warn?.(`[checkpoint] countJsonl: failed to read ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return total;
  }
}

// ============================
// JSONL recounting helpers (standalone)
// ============================

const SHARD_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export async function countJsonlL0Records(dataDir: string, logger?: CheckpointLogger): Promise<number> {
  return _countJsonlLines(path.join(dataDir, "conversations"), logger);
}

export async function countJsonlL1Records(dataDir: string, logger?: CheckpointLogger): Promise<number> {
  return _countJsonlLines(path.join(dataDir, "records"), logger);
}

async function _countJsonlLines(dirPath: string, logger?: CheckpointLogger): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!SHARD_PATTERN.test(entry.name)) continue;
      try {
        const content = await fs.readFile(path.join(dirPath, entry.name), "utf-8");
        total += content.split("\n").filter((l) => l.trim().length > 0).length;
      } catch {
        logger?.warn?.(`[checkpoint] countJsonl: unable to read ${entry.name}, skipping`);
      }
    }
  } catch {
    logger?.info?.(`[checkpoint] countJsonl: directory not readable: ${dirPath}, returning 0`);
  }
  return total;
}
