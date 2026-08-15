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
  /**
   * L0 capture-round count (incremented once per capture in `captureAtomically`,
   * not per message). Display-purpose only — `recalibrate()` resyncs it from the
   * store via `countL0CaptureRounds()` (distinct session_key × recorded_at) after
   * cleanup, since the per-capture increment has no decrement path of its own.
   */
  l0_conversations_count: number;

  // ═══ L1 ═══
  /** Total L1 memories extracted across all time */
  total_memories_extracted: number;
}

/**
 * Source of truth counts injected into `recalibrate()`.
 * Decoupled from `IMemoryStore` so the method is unit-testable with stubs
 * and stays backend-agnostic (SQLite vs TCVDB).
 */
export interface RecalibrateSources {
  /** Actual L0 capture-round count (distinct session_key × recorded_at). */
  countL0CaptureRounds: () => number | Promise<number>;
  /** Actual L1 memory record count. */
  countL1: () => number | Promise<number>;
}

/** Snapshot of the three recalibratable aggregate counters. */
export interface RecalibrateCounters {
  l0: number;
  l1: number;
  mslp: number;
}

/** Result of a recalibrate pass — supports idempotency, dry-run and observability. */
export interface RecalibrateReport {
  /** False when nothing changed (caller may skip downstream work / disk write). */
  adjusted: boolean;
  dryRun: boolean;
  /** Origin of this recalibrate call ("startup" | "cleanup" | …), for metrics. */
  trigger?: string;
  before: RecalibrateCounters;
  after: RecalibrateCounters;
  /** before - after per counter (reportable as drift metric). */
  drift: RecalibrateCounters;
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

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
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
  // Recalibrate (counter drift repair)
  // ============================

  /**
   * Recalibrate drifted aggregate counters against actual store counts.
   *
   * Cleanup (memory-cleaner) and manual pruning delete L0/L1 data without
   * touching the checkpoint, so `l0_conversations_count`, `total_memories_extracted`,
   * and `memories_since_last_persona` permanently overstate reality. This method
   * clamps them back to truth.
   *
   * Safety boundary: only these three counters are touched. `total_processed` and
   * `scenes_processed` are intentionally left alone — they sit inside the L2
   * self-heal gate in pipeline-factory.ts (Math.max on regression), so changing
   * them here would be silently undone.
   *
   * mslp is shrunk by the number of removed L1 records (`max(0, mslp - removedL1)`),
   * never grown — growth belongs to the normal markL1ExtractionComplete path.
   *
   * @param src   Injected actual counts (store is source of truth; stubbable for tests).
   * @param opts  dryRun = compute report without persisting; trigger = metric label.
   * @returns     before/after/drift snapshot; `adjusted` is false when nothing changed.
   */
  async recalibrate(
    src: RecalibrateSources,
    opts?: { dryRun?: boolean; trigger?: string },
  ): Promise<RecalibrateReport> {
    const dryRun = opts?.dryRun ?? false;

    // Hold the lock across count + read + conditional write. Taking the counts
    // INSIDE the lock is required: otherwise markL1ExtractionComplete (which also
    // takes the lock) can land between the unlocked count and the locked read,
    // and its new increment gets wiped by writeRaw. before/after then share one
    // consistent snapshot, and dry-run / no-op safely skip writeRaw.
    return withFileLock(this.filePath, async () => {
      const actualL0 = await src.countL0CaptureRounds();
      const actualL1 = await src.countL1();

      const c = await this.readRaw();
      const before: RecalibrateCounters = {
        l0: c.l0_conversations_count,
        l1: c.total_memories_extracted,
        mslp: c.memories_since_last_persona,
      };
      const noop = (reason: string): RecalibrateReport => {
        this.logger.info(`[checkpoint] recalibrate skipped: ${reason}`);
        return { adjusted: false, dryRun, trigger: opts?.trigger, before, after: before, drift: { l0: 0, l1: 0, mslp: 0 } };
      };

      // Safety 1: a non-finite source (degraded store reporting NaN/-1) must
      // never overwrite real counters.
      const healthy = Number.isFinite(actualL0) && actualL0 >= 0 && Number.isFinite(actualL1) && actualL1 >= 0;
      if (!healthy) return noop(`unhealthy source (l0=${actualL0}, l1=${actualL1})`);

      // Safety 2: countL0/countL1 swallow runtime errors (SQLITE_BUSY, network
      // blip) and return 0 WITHOUT setting degraded. A 0 where the counter is
      // nonzero almost always means a transient store failure, not a real wipe —
      // refuse to zero out real counters. (cleaner keeps a min-retain floor, so a
      // legitimate "deleted everything" path doesn't produce this signal.)
      const zeroWipe = (actualL0 === 0 && before.l0 > 0) || (actualL1 === 0 && before.l1 > 0);
      if (zeroWipe) {
        return noop(`source returned 0 against nonzero counter (l0 ${before.l0}→${actualL0}, l1 ${before.l1}→${actualL1})`);
      }

      // Safety 3: readRaw returns DEFAULT_CHECKPOINT on parse failure. If the file
      // exists on disk but read back as all-zero, it's corrupt — don't overwrite
      // it with default (would clobber runner_states/pipeline_states). First-run
      // (file absent → all-zero is legitimate) falls through.
      if (before.l0 === 0 && before.l1 === 0 && before.mslp === 0) {
        let fileExists = false;
        try { await fs.access(this.filePath); fileExists = true; } catch { /* absent */ }
        if (fileExists) return noop("checkpoint file unreadable (corrupt)");
      }

      const removedL1 = Math.max(0, c.total_memories_extracted - actualL1);
      // l0 only shrinks: TCVDB's countL0CaptureRounds falls back to per-message
      // countL0() which can exceed the true batch count — never inflate it.
      c.l0_conversations_count = Math.min(actualL0, c.l0_conversations_count);
      c.total_memories_extracted = actualL1;
      if (removedL1 > 0) {
        c.memories_since_last_persona = Math.max(0, c.memories_since_last_persona - removedL1);
      }
      const after: RecalibrateCounters = {
        l0: c.l0_conversations_count,
        l1: c.total_memories_extracted,
        mslp: c.memories_since_last_persona,
      };
      const drift: RecalibrateCounters = {
        l0: before.l0 - after.l0,
        l1: before.l1 - after.l1,
        mslp: before.mslp - after.mslp,
      };
      const adjusted = drift.l0 !== 0 || drift.l1 !== 0 || drift.mslp !== 0;
      if (!dryRun && adjusted) {
        await this.writeRaw(c);
      }
      return { adjusted, dryRun, trigger: opts?.trigger, before, after, drift };
    });
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

// ============================
// Wiring helper (startup + post-cleanup)
// ============================

/**
 * Recalibrate checkpoint counters from a live store, with a degraded guard and
 * a drift callback for metrics.
 *
 * This is the shared wiring point for startup (TdaiCore.initialize) and
 * post-cleanup (memory-cleaner) — it keeps the trigger / log / metric convention
 * in one place so the two callers stay consistent.
 *
 * Pure: does NOT import the reporter. Callers pass an `onDrift` callback that
 * forwards to the metric system, keeping checkpoint.ts free of core/report deps.
 *
 * @returns the recalibrate report, or `null` if the store is degraded (no-op).
 */
export async function recalibrateCheckpointFromStore(opts: {
  dataDir: string;
  store: {
    isDegraded(): boolean;
    countL0CaptureRounds(): number | Promise<number>;
    countL1(): number | Promise<number>;
  };
  trigger: string;
  logger?: CheckpointLogger;
  onDrift?: (report: RecalibrateReport) => void;
}): Promise<RecalibrateReport | null> {
  const { dataDir, store, trigger, logger, onDrift } = opts;
  if (store.isDegraded()) return null;
  const checkpoint = new CheckpointManager(dataDir, logger);
  try {
    const result = await checkpoint.recalibrate(
      {
        countL0CaptureRounds: () => store.countL0CaptureRounds(),
        countL1: () => store.countL1(),
      },
      { trigger },
    );
    if (result.adjusted) {
      logger?.info?.(
        `[checkpoint] recalibrate:${trigger} l0 ${result.before.l0}→${result.after.l0}, ` +
        `l1 ${result.before.l1}→${result.after.l1}, mslp ${result.before.mslp}→${result.after.mslp}`,
      );
      onDrift?.(result);
    }
    return result;
  } catch (err) {
    logger?.info?.(
      `[checkpoint] recalibrate:${trigger} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
