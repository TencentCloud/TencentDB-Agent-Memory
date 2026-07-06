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
import type { IMemoryStore } from "../core/store/types.js";

// ============================
// Types
// ============================

/**
 * Per-session state managed by L0/L1 runners (written directly to checkpoint).
 * These fields are ONLY written by CheckpointManager methods (markL1*, advanceSession*, etc.)
 * and are NEVER touched by the PipelineManager's persistStates().
 */
export interface RunnerSessionState {
  // ═══ L0 — per-session capture cursor ═══
  /** Epoch ms of the newest message captured for THIS session.
   *  Used instead of the global `Checkpoint.last_captured_timestamp` so that
   *  concurrent sessions don't advance each other's cursors and cause missed messages. */
  last_captured_timestamp: number;

  // ═══ L1 — cursor & continuity ═══
  /** L0 JSONL cursor: epoch ms of last message processed by L1 */
  last_l1_cursor: number;
  /** Last scene name from the most recent L1 extraction (for cross-batch continuity) */
  last_scene_name: string;
}

/**
 * Per-session state managed exclusively by PipelineManager (written via mergePipelineStates).
 * These fields are ONLY written by the pipeline's persistStates() callback
 * and are NEVER touched by CheckpointManager's L0/L1 methods.
 */
export interface PipelineSessionState {
  /** Conversation rounds since last L1 trigger */
  conversation_count: number;
  /** ISO timestamp of the last extraction completion */
  last_extraction_time: string;
  /** ISO timestamp cursor for incremental extraction reads */
  last_extraction_updated_time: string;
  /** Epoch ms of the last notifyConversation call */
  last_active_time: number;
  /** Mirrors conversation_count at L1 completion time (for L2 tracking) */
  l2_pending_l1_count: number;
  /**
   * Current warm-up threshold for L1 triggering.
   * Starts at 1 for new sessions and doubles after each L1 completion
   * (1 → 2 → 4 → 8 → ...) until it reaches everyNConversations.
   * 0 means warm-up is complete (use everyNConversations directly).
   */
  warmup_threshold: number;
  /** ISO timestamp of last L2 extraction completion */
  l2_last_extraction_time: string;
}

export interface Checkpoint {
  // ═══ Global counters ═══
  /** Epoch ms of the newest message successfully uploaded. Messages with ts > this are new. */
  last_captured_timestamp: number;
  /** Total messages processed across all time */
  total_processed: number;
  last_persona_at: number;
  last_persona_time: string;
  request_persona_update: boolean;
  persona_update_reason: string;
  memories_since_last_persona: number;
  scenes_processed: number;

  // ═══ Per-session split state ═══
  /** Runner-managed per-session state (L0 capture cursor, L1 cursor, scene name).
   *  Written ONLY by CheckpointManager methods. */
  runner_states: Record<string, RunnerSessionState>;
  /** Pipeline-managed per-session state (conversation_count, extraction times, etc.).
   *  Written ONLY by the pipeline's mergePipelineStates(). */
  pipeline_states: Record<string, PipelineSessionState>;

  // ═══ L0 ═══
  /** Total L0 conversation files recorded */
  l0_conversations_count: number;

  // ═══ L1 ═══
  /** Total L1 memories extracted across all time */
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
  warmup_threshold: 0, // 0 = graduated (safe default for old sessions missing this field)
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

function normalizeOptionalCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
}

export interface CheckpointRecalibrationCounts {
  /** Actual L0 rows currently present in the store. */
  l0ConversationsCount?: number;
  /** Actual L0 rows currently present; used by status/persona counters. */
  totalProcessed?: number;
  /** True when local L0 JSONL shards were read, including empty shards. */
  hasLocalL0Stats?: boolean;
  /** Newest L0 message timestamp currently present. */
  maxL0Timestamp?: number;
  /** Newest L0 message timestamp currently present per session key. */
  maxL0TimestampBySession?: Record<string, number>;
  /** Actual L1 records currently present in the store. */
  totalMemoriesExtracted?: number;
  /** True when local L1 JSONL shards were read, including empty shards. */
  hasLocalL1Stats?: boolean;
  /** Newest L1 updatedAt timestamp currently present. */
  maxL1UpdatedAt?: string;
  /** Newest L1 updatedAt timestamp currently present per session key. */
  maxL1UpdatedAtBySession?: Record<string, string>;
}

export interface CheckpointDecrementCounts {
  /** Known decrease for l0_conversations_count. */
  l0ConversationsCount?: number;
  /** Known number of removed L0 messages. */
  totalProcessed?: number;
  /** Known number of removed L1 records. */
  totalMemoriesExtracted?: number;
  /** Known number of removed memories from the persona threshold window. */
  memoriesSinceLastPersona?: number;
}

const noopLogger: CheckpointLogger = { info() {} };

/**
 * Reconcile checkpoint counters from actual persisted row counts.
 * Local JSONL shards are the durable source when present; store counts are
 * retained as the fallback for remote/degraded deployments without local files.
 */
export async function recalibrateCheckpointFromStore(
  dataDir: string,
  store: Pick<IMemoryStore, "countL0" | "countL1">,
  logger?: CheckpointLogger,
): Promise<void> {
  const [storeL0Count, storeL1Count, jsonlL0Stats, jsonlL1Stats] = await Promise.all([
    store.countL0(),
    store.countL1(),
    readLocalJsonlStats(dataDir, "conversations"),
    readLocalJsonlStats(dataDir, "records"),
  ]);
  const checkpoint = new CheckpointManager(dataDir, logger);
  await checkpoint.recalibrate({
    l0ConversationsCount: jsonlL0Stats?.count ?? storeL0Count,
    totalProcessed: jsonlL0Stats?.count ?? storeL0Count,
    hasLocalL0Stats: jsonlL0Stats !== undefined,
    maxL0Timestamp: jsonlL0Stats?.maxTimestamp,
    maxL0TimestampBySession: jsonlL0Stats?.maxTimestampBySession,
    totalMemoriesExtracted: jsonlL1Stats?.count ?? storeL1Count,
    hasLocalL1Stats: jsonlL1Stats !== undefined,
    maxL1UpdatedAt: jsonlL1Stats?.maxUpdatedAt,
    maxL1UpdatedAtBySession: jsonlL1Stats?.maxUpdatedAtBySession,
  });
}

export async function recalibrateCheckpointFromLocalData(
  dataDir: string,
  logger?: CheckpointLogger,
): Promise<void> {
  await recalibrateCheckpointFromStore(
    dataDir,
    {
      countL0: () => 0,
      countL1: () => 0,
    },
    logger,
  );
}

// ============================
// Per-file async lock
// ============================
// Keyed by resolved file path. Multiple CheckpointManager instances pointing
// to the same file automatically share the same lock — callers don't need to
// coordinate instance creation.

const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize async critical sections per file path.
 * Under no contention the overhead is a single resolved-promise await.
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // Chain after whatever is currently queued for this path
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  fileLocks.set(filePath, gate);

  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map entry if we're the tail of the chain
    if (fileLocks.get(filePath) === gate) {
      fileLocks.delete(filePath);
    }
  }
}

interface LocalJsonlStats {
  count: number;
  maxTimestamp?: number;
  maxTimestampBySession: Record<string, number>;
  maxUpdatedAt?: string;
  maxUpdatedAtBySession: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function getTimestampMs(record: Record<string, unknown>): number | undefined {
  const timestamp = record.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
  const recordedAt = getStringField(record, "recordedAt", "recorded_at");
  if (!recordedAt) return undefined;
  const ms = Date.parse(recordedAt);
  return Number.isFinite(ms) ? ms : undefined;
}

function getUpdatedAt(record: Record<string, unknown>): string | undefined {
  return getStringField(record, "updatedAt", "updated_at", "updated_time");
}

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

async function readLocalJsonlStats(dataDir: string, subdir: "conversations" | "records"): Promise<LocalJsonlStats | undefined> {
  const dir = path.join(dataDir, subdir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const stats: LocalJsonlStats = {
    count: 0,
    maxTimestampBySession: {},
    maxUpdatedAtBySession: {},
  };
  let sawShard = false;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    sawShard = true;
    try {
      const raw = await fs.readFile(path.join(dir, entry.name), "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        stats.count += 1;
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = asRecord(JSON.parse(trimmed));
        } catch {
          continue;
        }
        if (!parsed) continue;
        const sessionKey = getStringField(parsed, "sessionKey", "session_key");
        const timestamp = getTimestampMs(parsed);
        if (timestamp !== undefined) {
          stats.maxTimestamp = Math.max(stats.maxTimestamp ?? 0, timestamp);
          if (sessionKey) {
            stats.maxTimestampBySession[sessionKey] = Math.max(
              stats.maxTimestampBySession[sessionKey] ?? 0,
              timestamp,
            );
          }
        }
        const updatedAt = getUpdatedAt(parsed);
        if (updatedAt) {
          stats.maxUpdatedAt = maxIso(stats.maxUpdatedAt, updatedAt);
          if (sessionKey) {
            stats.maxUpdatedAtBySession[sessionKey] = maxIso(
              stats.maxUpdatedAtBySession[sessionKey],
              updatedAt,
            )!;
          }
        }
      }
    } catch {
      // Recalibration is best-effort; unreadable shards should not block startup.
    }
  }
  return sawShard ? stats : undefined;
}

export class CheckpointManager {
  private filePath: string;
  private logger: CheckpointLogger;

  constructor(dataDir: string, logger?: CheckpointLogger) {
    this.filePath = path.join(dataDir, ".metadata", "recall_checkpoint.json");
    this.logger = logger ?? noopLogger;
  }

  // ============================
  // Low-level I/O (internal)
  // ============================

  private async readRaw(): Promise<Checkpoint> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Merge with defaults for backward compat (old checkpoints lack new fields).
      // structuredClone avoids shallow-copy pitfall: without it, the nested
      // runner_states/pipeline_states objects in DEFAULT_CHECKPOINT would be
      // shared across all callers and mutated in place — corrupting the default.
      const cp = { ...structuredClone(DEFAULT_CHECKPOINT), ...parsed } as Checkpoint;

      // Migrate from old session_states format (pre-split)
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
        // Ensure per-session states have all fields with defaults
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

  /** Atomic write: write to tmp file, then rename into place. */
  private async writeRaw(checkpoint: Checkpoint): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }

  // ============================
  // Locked read-modify-write helper
  // ============================

  /**
   * Execute a mutating operation under the per-file lock.
   * `fn` receives the current checkpoint and may modify it in place;
   * the updated checkpoint is atomically written back.
   */
  private async mutate(fn: (cp: Checkpoint) => void | Promise<void>): Promise<Checkpoint> {
    return withFileLock(this.filePath, async () => {
      const cp = await this.readRaw();
      await fn(cp);
      await this.writeRaw(cp);
      return cp;
    });
  }

  // ============================
  // Public API — read-only
  // ============================

  /**
   * Read the current checkpoint (unlocked snapshot).
   *
   * NOTE: This does NOT acquire the file lock. The returned snapshot may be
   * stale if a concurrent `mutate()` is in progress. This is acceptable for
   * read-only uses (status display, deciding whether to run a pipeline step).
   *
   * For read-then-write patterns, always use `mutate()` instead — it acquires
   * the lock and re-reads from disk inside the critical section, ensuring the
   * update is based on the latest state.
   */
  async read(): Promise<Checkpoint> {
    return this.readRaw();
  }

  /** Write a full checkpoint (acquires lock + atomic write). */
  async write(checkpoint: Checkpoint): Promise<void> {
    return withFileLock(this.filePath, () => this.writeRaw(checkpoint));
  }

  // ============================
  // Public API — mutating (all serialized via file lock)
  // ============================

  // ============================
  // Persona methods (L3)
  // ============================

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
    const cp = await this.mutate((cp) => {
      cp.scenes_processed += 1;
    });
    this.logger.info(`[checkpoint] incrementScenesProcessed: scenes_processed=${cp.scenes_processed}`);
  }

  // ============================
  // Per-session helpers — runner state (L0/L1 owned)
  // ============================

  /**
   * Get or create runner session state for a session.
   */
  getRunnerState(cp: Checkpoint, sessionKey: string): RunnerSessionState {
    if (!cp.runner_states) {
      cp.runner_states = {};
    }
    let state = cp.runner_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_RUNNER_STATE };
      cp.runner_states[sessionKey] = state;
    }
    return state;
  }

  // ============================
  // Per-session helpers — pipeline state (PipelineManager owned)
  // ============================

  /**
   * Get or create pipeline session state for a session.
   */
  getPipelineState(cp: Checkpoint, sessionKey: string): PipelineSessionState {
    if (!cp.pipeline_states) {
      cp.pipeline_states = {};
    }
    let state = cp.pipeline_states[sessionKey];
    if (!state) {
      state = { ...DEFAULT_PIPELINE_STATE, last_active_time: Date.now() };
      cp.pipeline_states[sessionKey] = state;
    }
    return state;
  }

  /**
   * Get all pipeline states from checkpoint.
   */
  getAllPipelineStates(cp: Checkpoint): Record<string, PipelineSessionState> {
    return cp.pipeline_states ?? {};
  }

  /**
   * Merge pipeline session states into the checkpoint (used by pipeline persister).
   * Acquires the file lock so this is safe against concurrent mutations.
   *
   * This writes ONLY to `pipeline_states`, never touching `runner_states`.
   * This is the core guarantee that eliminates the split-brain overwrite bug.
   */
  async mergePipelineStates(states: Record<string, PipelineSessionState>): Promise<void> {
    await this.mutate((cp) => {
      if (!cp.pipeline_states) cp.pipeline_states = {};
      for (const [key, pState] of Object.entries(states)) {
        cp.pipeline_states[key] = {
          ...cp.pipeline_states[key],
          ...pState,
        };
      }
    });
  }

  /**
   * Decrement aggregate checkpoint counters when a cleanup path knows exactly
   * how many rows it removed. Use recalibrate() when removals may have happened
   * outside the current process or cursor bounds need repair.
   */
  async decrementCounters(counts: CheckpointDecrementCounts): Promise<void> {
    const l0ConversationsCount = normalizeOptionalCount(counts.l0ConversationsCount);
    const totalProcessed = normalizeOptionalCount(counts.totalProcessed);
    const totalMemoriesExtracted = normalizeOptionalCount(counts.totalMemoriesExtracted);
    const memoriesSinceLastPersona = normalizeOptionalCount(counts.memoriesSinceLastPersona);

    const cp = await this.mutate((cp) => {
      if (l0ConversationsCount !== undefined) {
        cp.l0_conversations_count = Math.max(0, cp.l0_conversations_count - l0ConversationsCount);
      }
      if (totalProcessed !== undefined) {
        cp.total_processed = Math.max(0, cp.total_processed - totalProcessed);
      }
      if (totalMemoriesExtracted !== undefined) {
        cp.total_memories_extracted = Math.max(0, cp.total_memories_extracted - totalMemoriesExtracted);
      }
      if (memoriesSinceLastPersona !== undefined) {
        cp.memories_since_last_persona = Math.max(0, cp.memories_since_last_persona - memoriesSinceLastPersona);
      }
      cp.memories_since_last_persona = Math.min(
        cp.memories_since_last_persona,
        cp.total_memories_extracted,
      );
    });

    this.logger.info(
      `[checkpoint] decrementCounters: l0_conversations_count=${cp.l0_conversations_count}, ` +
      `total_processed=${cp.total_processed}, ` +
      `total_memories_extracted=${cp.total_memories_extracted}, ` +
      `memories_since_last_persona=${cp.memories_since_last_persona}`,
    );
  }

  /**
   * Reconcile aggregate checkpoint counters with counts from the actual store.
   *
   * These counters are incremented on capture/extraction, but cleanup paths can
   * remove rows from JSONL/SQLite later. Recalibration keeps status reporting
   * and persona thresholds from drifting upward forever.
   */
  async recalibrate(counts: CheckpointRecalibrationCounts): Promise<void> {
    const l0ConversationsCount = normalizeOptionalCount(counts.l0ConversationsCount);
    const totalProcessed = normalizeOptionalCount(counts.totalProcessed);
    const maxL0Timestamp = normalizeOptionalCount(counts.maxL0Timestamp);
    const totalMemoriesExtracted = normalizeOptionalCount(counts.totalMemoriesExtracted);
    const maxL1UpdatedAt = counts.maxL1UpdatedAt;

    const cp = await this.mutate((cp) => {
      if (l0ConversationsCount !== undefined) {
        cp.l0_conversations_count = l0ConversationsCount;
      }
      if (totalProcessed !== undefined) {
        cp.total_processed = totalProcessed;
      }
      if (counts.hasLocalL0Stats || maxL0Timestamp !== undefined) {
        const cursorMax = maxL0Timestamp ?? 0;
        cp.last_captured_timestamp = Math.min(cp.last_captured_timestamp, cursorMax);
        for (const [sessionKey, state] of Object.entries(cp.runner_states ?? {})) {
          const sessionMax = counts.hasLocalL0Stats
            ? counts.maxL0TimestampBySession?.[sessionKey] ?? 0
            : counts.maxL0TimestampBySession?.[sessionKey] ?? cursorMax;
          state.last_captured_timestamp = Math.min(state.last_captured_timestamp, sessionMax);
          state.last_l1_cursor = Math.min(state.last_l1_cursor, sessionMax);
        }
      }
      if (totalMemoriesExtracted !== undefined) {
        cp.total_memories_extracted = totalMemoriesExtracted;
        cp.memories_since_last_persona = Math.min(
          cp.memories_since_last_persona,
          totalMemoriesExtracted,
        );
      }
      if (counts.hasLocalL1Stats || maxL1UpdatedAt) {
        for (const [sessionKey, state] of Object.entries(cp.pipeline_states ?? {})) {
          const sessionMax = counts.hasLocalL1Stats
            ? counts.maxL1UpdatedAtBySession?.[sessionKey] ?? ""
            : counts.maxL1UpdatedAtBySession?.[sessionKey] ?? maxL1UpdatedAt ?? "";
          if (state.last_extraction_updated_time && state.last_extraction_updated_time > sessionMax) {
            state.last_extraction_updated_time = sessionMax;
          }
        }
      }
    });

    this.logger.info(
      `[checkpoint] recalibrate: l0_conversations_count=${cp.l0_conversations_count}, ` +
      `total_processed=${cp.total_processed}, ` +
      `total_memories_extracted=${cp.total_memories_extracted}, ` +
      `memories_since_last_persona=${cp.memories_since_last_persona}`,
    );
  }

  // ============================
  // L1-specific methods
  // ============================

  /**
   * Mark L1 extraction completed: reset sinceL1 counter, advance L1 cursor,
   * and optionally save the last scene name for cross-batch continuity.
   *
   * @param cursorRecordedAtMs - The max recorded_at epoch ms of processed L0 messages.
   *   This becomes the new `last_l1_cursor` value (recorded_at semantics, not conversation timestamp).
   */
  async markL1ExtractionComplete(
    sessionKey: string,
    memoriesExtracted: number,
    cursorRecordedAtMs?: number,
    lastSceneName?: string,
  ): Promise<void> {
    await this.mutate((cp) => {
      const state = this.getRunnerState(cp, sessionKey);
      if (cursorRecordedAtMs) {
        state.last_l1_cursor = cursorRecordedAtMs;
      }
      if (lastSceneName !== undefined) {
        state.last_scene_name = lastSceneName;
      }
      cp.total_memories_extracted += memoriesExtracted;
      cp.memories_since_last_persona += memoriesExtracted;
    });
    this.logger.info(
      `[checkpoint] markL1ExtractionComplete session=${sessionKey}: ` +
      `extracted=${memoriesExtracted}, cursor=${cursorRecordedAtMs ?? "(unchanged)"}, ` +
      `lastScene="${lastSceneName ?? "(unchanged)"}"`,
    );
  }

  // ============================
  // Atomic capture (race-condition fix)
  // ============================

  /**
   * Atomically read the per-session cursor, execute the capture callback,
   * and advance the cursor — all within a single file-lock critical section.
   *
   * This eliminates the race window that existed when `read()` (unlocked) and
   * `advanceSessionCapturedTimestamp()` (locked) were separate calls:
   * two concurrent `agent_end` events could both read the same stale cursor
   * and record duplicate messages.
   *
   * The callback receives `afterTimestamp` (the current per-session cursor)
   * and must return either:
   *   - `{ maxTimestamp, messageCount }` to advance the cursor, or
   *   - `null` to leave the cursor unchanged (nothing captured).
   *
   * L0 conversation count is also incremented inside the lock when messages
   * are captured, removing the need for a separate `incrementL0ConversationCount()` call.
   *
   * @param sessionKey   Per-session identifier
   * @param pluginStartTimestamp  Cold-start floor (used when no cursor exists yet)
   * @param fn  Async callback that performs the actual capture (recordConversation, etc.)
   */
  async captureAtomically(
    sessionKey: string,
    pluginStartTimestamp: number | undefined,
    fn: (afterTimestamp: number) => Promise<{ maxTimestamp: number; messageCount: number } | null>,
  ): Promise<void> {
    await this.mutate(async (cp) => {
      // Read the per-session cursor inside the lock
      const state = this.getRunnerState(cp, sessionKey);
      let afterTimestamp = state.last_captured_timestamp || 0;

      // Cold-start guard (same logic that was previously in auto-capture.ts)
      if (afterTimestamp === 0 && pluginStartTimestamp && pluginStartTimestamp > 0) {
        afterTimestamp = pluginStartTimestamp;
      }

      const result = await fn(afterTimestamp);

      if (result) {
        // Advance per-session cursor (runner-owned)
        state.last_captured_timestamp = result.maxTimestamp;
        // Global stats (aggregate only — not used for filtering)
        cp.last_captured_timestamp = Math.max(cp.last_captured_timestamp, result.maxTimestamp);
        cp.total_processed += result.messageCount;
        // Increment L0 conversation count (was a separate mutate() call before)
        cp.l0_conversations_count += 1;
      }
    });
  }

}
