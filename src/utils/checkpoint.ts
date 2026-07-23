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

  // ═══ Recalibration audit ═══
  /** ISO timestamp of the last successful recalibrate() call. Empty string when never run. */
  last_recalibrated_at: string;
  /**
   * Rolling history of recalibrate() runs that detected drift (changed=true).
   * Capped at DRIFT_HISTORY_MAX entries; oldest entry is evicted when full.
   * Lets operators distinguish "normal post-cleanup drift of ~20" from
   * "sudden spike of 500 records" without digging through logs.
   */
  drift_history: Array<{ at: string; l0_delta: number; l1_delta: number }>;
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
  last_recalibrated_at: "",
  drift_history: [],
};

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
}

/**
 * Minimal view of the memory store needed for recalibration.
 * Structural (no IMemoryStore import) so checkpoint.ts stays free of store-layer
 * deps and unit tests can pass a tiny fake.
 */
export interface RecalibrationSource {
  /** Live count of L0 conversation records (messages in `l0_conversations`). */
  countL0(): number | Promise<number>;
  /** Live count of L1 memory records. */
  countL1(): number | Promise<number>;
}

export interface RecalibrateResult {
  l0: { before: number; after: number };
  l1: { before: number; after: number };
  /** Persona-interval counter — clamped when L1 shrinks after cleanup. */
  memories_since_last_persona: { before: number; after: number };
  /**
   * Number of scene-block files found on disk. Recalibrated from the
   * filesystem regardless of `source` — scene files are never stored in
   * the vector store.
   *
   * Note: `total_processed` (message-capture counter) is intentionally NOT
   * recalibrated — it is a monotonic epoch used as `last_persona_at` and
   * changing it would corrupt the relative marker semantics.
   */
  scenes_processed: { before: number; after: number };
  /** "store" when live store counts were used; "jsonl" for daily-shard line counts. */
  source: "store" | "jsonl";
  /** True when any reconciled field actually changed. */
  changed: boolean;
}

/** Maximum number of entries retained in `drift_history`. */
const DRIFT_HISTORY_MAX = 10;

/** Read-only drift snapshot — does not mutate the checkpoint. */
export interface DriftReport {
  l0: { stored: number; actual: number; delta: number };
  l1: { stored: number; actual: number; delta: number };
  /** "store" when live store counts were used; "jsonl" for daily-shard line counts. */
  source: "store" | "jsonl";
  /** True when any counter overstates actual data by more than `tolerance`. */
  hasDrift: boolean;
}

const noopLogger: CheckpointLogger = { info() {} };

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

export class CheckpointManager {
  private dataDir: string;
  private filePath: string;
  private logger: CheckpointLogger;

  constructor(dataDir: string, logger?: CheckpointLogger) {
    this.dataDir = dataDir;
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

  /**
   * Atomically raise any global counter that has fallen below a known-good
   * floor value. Used by the L2 runner to guard against race-condition
   * counter rollback without resorting to a full `checkpoint.write()` that
   * would clobber concurrent increments.
   *
   * Only `total_processed` and `memories_since_last_persona` are covered —
   * `scenes_processed` is intentionally excluded because `recalibrate()` can
   * legitimately lower it when scene files are deleted.
   */
  async floorGlobalCounters(floors: {
    total_processed: number;
    memories_since_last_persona: number;
  }): Promise<void> {
    await this.mutate((cp) => {
      if (cp.total_processed < floors.total_processed) {
        cp.total_processed = floors.total_processed;
      }
      if (cp.memories_since_last_persona < floors.memories_since_last_persona) {
        cp.memories_since_last_persona = floors.memories_since_last_persona;
      }
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

  // ============================
  // Drift detection (read-only) — issue #157
  // ============================

  /**
   * Compare stored counters against live data without mutating anything.
   *
   * Use this for health-checks or periodic monitoring. When drift is detected
   * (`hasDrift === true`), call `recalibrate()` to correct it.
   *
   * @param source Optional live-count provider. Omit to use JSONL fallback.
   * @param tolerance Maximum allowed overcount before `hasDrift` is set.
   *   Defaults to 0 (any overcount is reported).
   */
  async detectDrift(source?: RecalibrationSource, tolerance = 0): Promise<DriftReport> {
    let l0Actual: number;
    let l1Actual: number;
    let usedSource: "store" | "jsonl";

    if (source) {
      l0Actual = await source.countL0();
      l1Actual = await source.countL1();
      usedSource = "store";
    } else {
      l0Actual = await this.countJsonlLines("conversations");
      l1Actual = await this.countJsonlLines("records");
      usedSource = "jsonl";
    }

    l0Actual = Number.isFinite(l0Actual) && l0Actual >= 0 ? Math.floor(l0Actual) : 0;
    l1Actual = Number.isFinite(l1Actual) && l1Actual >= 0 ? Math.floor(l1Actual) : 0;

    const cp = await this.read();
    const l0Delta = cp.l0_conversations_count - l0Actual;
    const l1Delta = cp.total_memories_extracted - l1Actual;
    const hasDrift = l0Delta > tolerance || l1Delta > tolerance;

    const report: DriftReport = {
      l0: { stored: cp.l0_conversations_count, actual: l0Actual, delta: l0Delta },
      l1: { stored: cp.total_memories_extracted, actual: l1Actual, delta: l1Delta },
      source: usedSource,
      hasDrift,
    };

    if (hasDrift) {
      this.logger.warn?.(
        `[checkpoint] drift detected (source=${usedSource}): ` +
        `l0 stored=${report.l0.stored} actual=${report.l0.actual} delta=${l0Delta}, ` +
        `l1 stored=${report.l1.stored} actual=${report.l1.actual} delta=${l1Delta}`,
      );
    }

    return report;
  }

  // ============================
  // Recalibration (drift correction) — issue #157
  // ============================

  /**
   * Reconcile increment-only counters against reality.
   *
   * ## Why
   * `l0_conversations_count` and `total_memories_extracted` only ever grow
   * (`captureAtomically` / `markL1ExtractionComplete`). memory-cleaner (and
   * manual JSONL pruning) delete records without updating the checkpoint, so
   * counters permanently overstate how much data exists. Inflated values skew
   * status reporting and L2/L3 persona thresholds (`memories_since_last_persona`).
   *
   * ## Source of truth
   * Prefer the live store (`countL0` / `countL1`) — the same queries the cleaner
   * uses. When no store is available (degraded mode), fall back to counting
   * non-empty lines in `conversations/` and `records/` daily JSONL shards.
   *
   * ## Persona clamp
   * When L1 shrinks, `memories_since_last_persona` is reduced by the same delta
   * (floored at 0) and never allowed to exceed the new L1 total. This stops
   * cleanup from leaving a stale interval that would prematurely trigger persona
   * generation — a gap many naive recalibrate patches miss.
   *
   * Idempotent and lock-safe (write goes through `mutate`). Count resolution
   * happens *outside* the lock so slow store/FS I/O does not block other writers.
   *
   * @param source Optional live-count provider (typically the vector store).
   *   Omit to force the JSONL fallback.
   */
  async recalibrate(source?: RecalibrationSource): Promise<RecalibrateResult> {
    let l0True: number;
    let l1True: number;
    let usedSource: "store" | "jsonl";

    if (source) {
      l0True = await source.countL0();
      l1True = await source.countL1();
      usedSource = "store";
    } else {
      l0True = await this.countJsonlLines("conversations");
      l1True = await this.countJsonlLines("records");
      usedSource = "jsonl";
    }

    // scenes_processed is always counted from the filesystem — scene files are
    // never stored in the vector store, so there is no store-backed alternative.
    const scenesTrue = await this.countSceneFiles();

    // Guard against transient failures returning nonsense (NaN / negatives).
    l0True = Number.isFinite(l0True) && l0True >= 0 ? Math.floor(l0True) : 0;
    l1True = Number.isFinite(l1True) && l1True >= 0 ? Math.floor(l1True) : 0;

    let before = {
      l0: 0,
      l1: 0,
      memories_since_last_persona: 0,
      scenes_processed: 0,
    };
    let afterPersona = 0;
    let afterScenes = 0;

    await this.mutate((cp) => {
      before = {
        l0: cp.l0_conversations_count,
        l1: cp.total_memories_extracted,
        memories_since_last_persona: cp.memories_since_last_persona,
        scenes_processed: cp.scenes_processed,
      };

      cp.l0_conversations_count = l0True;
      cp.total_memories_extracted = l1True;
      cp.scenes_processed = scenesTrue;

      // Shrink memories_since_last_persona proportionally when L1 shrinks.
      //
      // Cleanup always removes the OLDEST records first (time-based retention).
      // Of the deleted records, only those that post-date the last persona
      // generation reduce the interval; pre-persona deletions are irrelevant.
      //
      // Example: total=50, memories_since=30 (newest 30 are "since persona"),
      //   cleanup deletes 30 oldest → 20 pre-persona + 10 post-persona deleted
      //   → memories_since should drop from 30 to 20, not to 0.
      //
      // Formula:
      //   deletedCount        = before.l1 - l1True
      //   beforePersonaCount  = before.l1 - persona   (records pre-dating last persona)
      //   deletedBeforePersona= min(deletedCount, max(0, beforePersonaCount))
      //   deletedSincePersona = deletedCount - deletedBeforePersona
      //   new persona         = max(0, persona - deletedSincePersona)
      let persona = cp.memories_since_last_persona;
      if (l1True < before.l1) {
        const deletedCount = before.l1 - l1True;
        const beforePersonaCount = Math.max(0, before.l1 - persona);
        const deletedBeforePersona = Math.min(deletedCount, beforePersonaCount);
        const deletedSincePersona = deletedCount - deletedBeforePersona;
        persona = Math.max(0, persona - deletedSincePersona);
      }
      persona = Math.min(persona, l1True);
      if (!Number.isFinite(persona) || persona < 0) persona = 0;
      cp.memories_since_last_persona = Math.floor(persona);
      afterPersona = cp.memories_since_last_persona;
      afterScenes = cp.scenes_processed;

      const now = new Date().toISOString();
      cp.last_recalibrated_at = now;

      // Append to drift_history only when something actually changed.
      const l0Delta = before.l0 - l0True;
      const l1Delta = before.l1 - l1True;
      if (l0Delta !== 0 || l1Delta !== 0) {
        if (!Array.isArray(cp.drift_history)) cp.drift_history = [];
        cp.drift_history.push({ at: now, l0_delta: l0Delta, l1_delta: l1Delta });
        if (cp.drift_history.length > DRIFT_HISTORY_MAX) {
          cp.drift_history.splice(0, cp.drift_history.length - DRIFT_HISTORY_MAX);
        }
      }
    });

    const result: RecalibrateResult = {
      l0: { before: before.l0, after: l0True },
      l1: { before: before.l1, after: l1True },
      memories_since_last_persona: {
        before: before.memories_since_last_persona,
        after: afterPersona,
      },
      scenes_processed: {
        before: before.scenes_processed,
        after: afterScenes,
      },
      source: usedSource,
      changed:
        before.l0 !== l0True
        || before.l1 !== l1True
        || before.memories_since_last_persona !== afterPersona
        || before.scenes_processed !== afterScenes,
    };

    if (result.changed) {
      this.logger.info(
        `[checkpoint] recalibrate (source=${usedSource}): ` +
        `l0 ${result.l0.before}→${result.l0.after}, ` +
        `l1 ${result.l1.before}→${result.l1.after}, ` +
        `memories_since_last_persona ${result.memories_since_last_persona.before}→${result.memories_since_last_persona.after}, ` +
        `scenes_processed ${result.scenes_processed.before}→${result.scenes_processed.after}`,
      );
    } else {
      this.logger.info(
        `[checkpoint] recalibrate (source=${usedSource}): no drift ` +
        `(l0=${result.l0.after}, l1=${result.l1.after}, ` +
        `memories_since_last_persona=${result.memories_since_last_persona.after}, ` +
        `scenes_processed=${result.scenes_processed.after})`,
      );
    }
    return result;
  }

  /**
   * Drop per-session runner/pipeline state for one session, then recalibrate
   * global counters against remaining data.
   *
   * Use after wiping a session's L0/L1 records (test teardown, `/reset`, or
   * manual JSONL pruning for a single sessionKey). Without this, deleting
   * `pipeline_states[session]` leaves global totals inflated — the exact
   * drift path described in #157.
   *
   * @param sessionKey Session to clear from `runner_states` / `pipeline_states`
   * @param source Optional live store; omit for JSONL fallback
   */
  async resetSession(
    sessionKey: string,
    source?: RecalibrationSource,
  ): Promise<RecalibrateResult> {
    await this.mutate((cp) => {
      if (cp.runner_states) delete cp.runner_states[sessionKey];
      if (cp.pipeline_states) delete cp.pipeline_states[sessionKey];
    });
    this.logger.info(`[checkpoint] resetSession: cleared state for session=${sessionKey}`);
    return this.recalibrate(source);
  }

  /**
   * Count non-empty lines across daily `YYYY-MM-DD.jsonl|.json` shards in a
   * subdirectory of the plugin data dir. Used as the degraded-mode fallback
   * when no live store is available.
   */
  private async countJsonlLines(subDir: string): Promise<number> {
    const dirPath = path.join(this.dataDir, subDir);
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }

    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // Match memory-cleaner shard naming: YYYY-MM-DD.jsonl | YYYY-MM-DD.json
      if (!/^\d{4}-\d{2}-\d{2}\.(?:jsonl|json)$/.test(entry.name)) continue;

      let raw: string;
      try {
        raw = await fs.readFile(path.join(dirPath, entry.name), "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (line.trim().length > 0) total += 1;
      }
    }
    return total;
  }

  /**
   * Count `.md` files in `scene_blocks/` as the source of truth for
   * `scenes_processed`. Scene files live only on the filesystem — there is
   * no store-backed count — so this always reads the directory directly.
   */
  private async countSceneFiles(): Promise<number> {
    const dirPath = path.join(this.dataDir, "scene_blocks");
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }
    return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
  }

}
