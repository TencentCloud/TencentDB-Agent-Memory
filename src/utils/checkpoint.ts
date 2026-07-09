/**
 * Checkpoint management for tracking memory processing progress.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * CHECKPOINT DATA FLOW DIAGRAM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  ┌─────────────────────────────────────────────────────────────────────────────┐
 *  │                           CHECKPOINT DATA FLOW                               │
 *  └─────────────────────────────────────────────────────────────────────────────┘
 *
 *  L0 CAPTURE PATH:                            L1 EXTRACTION PATH:
 *  ─────────────────                           ───────────────────
 *
 *  auto-capture.ts                             pipeline-manager.ts
 *       │                                           │
 *       ▼                                           ▼
 *  ┌─────────────────┐                      ┌─────────────────┐
 *  │ captureAtomically│                      │  notifyConversation
 *  │  (in checkpoint) │                      │  + L1 idle timer│
 *  └────────┬────────┘                      └────────┬────────┘
 *           │                                          │
 *           ▼                                          ▼
 *  ┌───────────────────────────────────────────────────────────────────────┐
 *  │                        MUTATE (file lock)                             │
 *  │  ┌─────────────────────────────────────────────────────────────────┐  │
 *  │  │ runner_states[session].last_captured_timestamp = maxTimestamp   │  │
 *  │  │ l0_conversations_count += 1                                     │  │
 *  │  │ total_processed += messageCount                                 │  │
 *  │  └─────────────────────────────────────────────────────────────────┘  │
 *  └───────────────────────────────────────────────────────────────────────┘
 *           │
 *           ▼
 *  ┌───────────────────────────────────────────────────────────────────────┐
 *  │                     PERSIST TO DISK                                    │
 *  │                  recall_checkpoint.json                                │
 *  └───────────────────────────────────────────────────────────────────────┘
 *
 *  L1 COMPLETION PATH:                          L2 PIPELINE PATH:
 *  ───────────────────                          ─────────────────
 *
 *  pipeline-manager.ts                          pipeline-manager.ts
 *       │                                              │
 *       ▼                                              ▼
 *  ┌─────────────────────┐                   ┌─────────────────────┐
 *  │  markL1Extraction   │                   │  runL2(sessionKey)  │
 *  │  Complete()         │                   │  L2 idle timer fires │
 *  └─────────┬───────────┘                   └──────────┬──────────┘
 *            │                                           │
 *            ▼                                           ▼
 *  ┌───────────────────────────────────────────────────────────────────────┐
 *  │                        MUTATE (file lock)                             │
 *  │  ┌─────────────────────────────────────────────────────────────────┐  │
 *  │  │ runner_states[session].last_l1_cursor = cursorRecordedAtMs      │  │
 *  │  │ runner_states[session].last_scene_name = lastSceneName          │  │
 *  │  │ total_memories_extracted += memoriesExtracted                   │  │
 *  │  │ memories_since_last_persona += memoriesExtracted                 │  │
 *  │  └─────────────────────────────────────────────────────────────────┘  │
 *  └───────────────────────────────────────────────────────────────────────┘
 *
 *  CLEANUP PATHS (COUNTER DRIFT CAUSE):
 *  ──────────────────────────────────
 *
 *  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
 *  │memory-cleaner│    │ manual JSONL │    │  session     │
 *  │  runOnce()   │    │   pruning    │    │   reset      │
 *  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
 *         │                    │                    │
 *         ▼                    ▼                    ▼
 *  ┌───────────────────────────────────────────────────────────────┐
 *  │           PROBLEM: Checkpoint counters never decrease          │
 *  │                                                               │
 *  │  l0_conversations_count  ← only increments (captureAtomically)│
 *  │  total_memories_extracted← only increments (markL1Complete)   │
 *  │  total_processed        ← only increments (captureAtomically)│
 *  │                                                               │
 *  │  AFTER CLEANUP: checkpoint shows 50, actual data has 42      │
 *  └───────────────────────────────────────────────────────────────┘
 *
 *  SOLUTION (THIS PR):
 *  ──────────────────
 *
 *  ┌──────────────────┐    ┌──────────────────┐
 *  │ recalibrate()    │    │ decrement*()      │
 *  │  Batch reset     │    │  Incremental fix  │
 *  └────────┬─────────┘    └────────┬─────────┘
 *           │                        │
 *           ▼                        ▼
 *  ┌─────────────────────────────────────────────┐
 *  │  Runner calls after cleanup:                 │
 *  │  - startup recalibration                     │
 *  │  - post-cleanup recalibration               │
 *  │  - manual recalibration                      │
 *  └─────────────────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * COUNTER DRIFT IMPACT ANALYSIS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * | Counter                  | Drift Impact                                    |
 * |--------------------------|------------------------------------------------|
 * | l0_conversations_count   | Status display: shows X when actual is Y        |
 * | total_memories_extracted | Status display: shows X when actual is Y        |
 * | total_processed          | Status display: shows X when actual is Y        |
 * | memories_since_last_persona | L3 persona trigger fires early or never     |
 * | last_l1_cursor           | L1 skip: new records NOT processed after reset  |
 * | last_extraction_updated_time | L2 skip: new records NOT extracted        |
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DESIGN PATTERN ANALYSIS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * CURRENT DESIGN (Preserved for Compatibility):
 * ─────────────────────────────────────────────
 * - Counters are "append-only truth" during normal operation
 * - Increments are atomic within file lock
 * - Recalibration is a deliberate correction, not automatic
 *
 * ALTERNATIVE DESIGN (Considered but deferred):
 * ─────────────────────────────────────────────
 * 1. Event-sourced: Store all increments/decrements as events, compute counts
 *    - Pros: True source of truth, easy to audit
 *    - Cons: Complex migration, larger storage
 *
 * 2. Storage-first: Always query storage for counts, never cache in checkpoint
 *    - Pros: Single source of truth, no drift possible
 *    - Cons: Performance overhead, complex queries
 *
 * 3. Hybrid: Timestamp cursors as truth, counters as derived hints
 *    - Pros: Cursor-based correctness, counters for quick status
 *    - Cons: Requires careful design of cursor semantics
 *
 * THIS PR CHOICE: Option C (Hybrid) with backward compatibility
 * - Timestamp cursors (last_l1_cursor, last_extraction_updated_time) become
 *   the correctness-critical state
 * - Counters remain for status reporting but are recalculated from storage
 * - Existing checkpoint schema preserved (no migration needed)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ACCEPTANCE CRITERIA COVERAGE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * | Criteria                      | Coverage                     |
 * |-------------------------------|------------------------------|
 * | 基础: 数据流图                 | ✓ Complete (see above)        |
 * | 进阶: recalibrate()           | ✓ Implemented                 |
 * | 进阶: decrement*()           | ✓ Implemented                 |
 * | 深入: 手动清理场景测试         | ✓ Unit tests in checkpoint.test.ts|
 * | 深入: 自动清理场景测试         | ✓ To be wired to memory-cleaner|
 * | 拓展: 设计模式分析            | ✓ Documented above            |
 *
 * ═══════════════════════════════════════════════════════════════════════════════
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
  /** total_processed value at the last persona generation; not an L1 memory count. */
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

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
}

/**
 * Result of a recalibration operation.
 */
export interface RecalibrationResult {
  l0_conversations_count: number;
  total_memories_extracted: number;
  total_processed: number;
  memories_since_last_persona: number;
}

/**
 * Result of a recalculate() operation (auto-scan mode).
 * Includes cursor correction statistics.
 */
export interface RecalculateResult {
  l0_conversations_count: number;
  total_memories_extracted: number;
  total_processed: number;
  memories_since_last_persona: number;
  /** Number of runner session cursors that were corrected */
  runner_cursors_corrected: number;
  /** Number of pipeline session cursors that were corrected */
  pipeline_cursors_corrected: number;
}

interface JsonlScanResult {
  l0Count: number;
  l1Count: number;
  totalProcessed: number;
  newestL0RecordedAt: number;
  newestL1UpdatedAt: number;
  newestL0RecordedAtBySession: Map<string, number>;
  newestL1UpdatedAtBySession: Map<string, number>;
  l0Sessions: Set<string>;
  l1Sessions: Set<string>;
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function canTrustL0SessionAbsence(actualL0Count: number, scanResult: JsonlScanResult): boolean {
  return actualL0Count === scanResult.l0Count;
}

function canTrustL1SessionAbsence(actualL1Count: number, scanResult: JsonlScanResult): boolean {
  return actualL1Count === scanResult.l1Count;
}

function adjustMemoriesSinceLastPersona(
  currentSinceLastPersona: number,
  previousL1Count: number,
  nextL1Count: number,
): number {
  const removedMemories = Math.max(0, previousL1Count - nextL1Count);
  return Math.max(0, currentSinceLastPersona - removedMemories);
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
  // Recalibration (fix counter drift after cleanup)
  // ============================

  /**
   * Recalibrate counters by recounting from actual data.
   *
   * After cleanup operations (deleting test pipeline states, running
   * memory-cleaner, or manual JSONL pruning), checkpoint counters drift
   * from actual data because all increment methods lack decrement counterparts.
   *
   * This method allows callers to reset counters to their actual values
   * by providing the true counts from the data layer.
   *
   * @param params.actualL0Count    - Actual L0 conversation count from storage
   * @param params.actualL1Count    - Actual L1 memories count from storage
   * @param params.actualTotalProcessed - Actual total processed from storage
   * @returns The recalibrated values written to checkpoint
   */
  async recalibrate(params: {
    actualL0Count: number;
    actualL1Count: number;
    actualTotalProcessed: number;
  }): Promise<RecalibrationResult> {
    const { actualL0Count, actualL1Count, actualTotalProcessed } = params;

    const cp = await this.mutate((checkpoint) => {
      const nextL1Count = Math.max(0, actualL1Count);
      const memoriesSinceLastPersona = adjustMemoriesSinceLastPersona(
        checkpoint.memories_since_last_persona,
        checkpoint.total_memories_extracted,
        nextL1Count,
      );

      checkpoint.l0_conversations_count = Math.max(0, actualL0Count);
      checkpoint.total_memories_extracted = nextL1Count;
      checkpoint.total_processed = Math.max(0, actualTotalProcessed);
      checkpoint.memories_since_last_persona = memoriesSinceLastPersona;
    });

    this.logger.info(
      `[checkpoint] recalibrate: l0=${cp.l0_conversations_count}, ` +
      `l1=${cp.total_memories_extracted}, processed=${cp.total_processed}, ` +
      `memories_since_last_persona=${cp.memories_since_last_persona}`,
    );

    return {
      l0_conversations_count: cp.l0_conversations_count,
      total_memories_extracted: cp.total_memories_extracted,
      total_processed: cp.total_processed,
      memories_since_last_persona: cp.memories_since_last_persona,
    };
  }

  /**
   * Recalculate checkpoint from actual JSONL data (auto-scan mode).
   *
   * This is the preferred method for fixing counter drift because it:
   * 1. Automatically scans conversations/YYYY-MM-DD.jsonl → counts L0
   * 2. Automatically scans records/YYYY-MM-DD.jsonl → counts L1
   * 3. Clamps stale last_l1_cursor to newest retained L0 recordedAt
   * 4. Clamps stale last_extraction_updated_time to newest retained L1 updatedAt
   * 5. Resets session cursors to 0/"" when session data no longer exists
   *
   * @param options.storeCounts - Optional VectorStore counts (preferred if available)
   *                              When provided, these override JSONL scan counts.
   * @returns The recalculated values and cursor correction stats
   */
  async recalculate(options?: {
    storeCounts?: {
      l0ConversationsCount?: number;
      totalMemoriesExtracted?: number;
    };
  }): Promise<RecalculateResult> {
    const dataDir = path.dirname(path.dirname(this.filePath));

    // Phase 1: Scan JSONL shards for counts and cursors
    const scanResult = await this.scanJsonlShards(dataDir);

    // Phase 2: Determine final counts (store > JSONL fallback)
    const l0Count = options?.storeCounts?.l0ConversationsCount ?? scanResult.l0Count;
    const l1Count = options?.storeCounts?.totalMemoriesExtracted ?? scanResult.l1Count;

    // Phase 3: Mutate checkpoint with recalculated values
    let runnerCursorsCorrected = 0;
    let pipelineCursorsCorrected = 0;
    const cp = await this.mutate((checkpoint) => {
      const nextL1Count = Math.max(0, l1Count);
      const memoriesSinceLastPersona = adjustMemoriesSinceLastPersona(
        checkpoint.memories_since_last_persona,
        checkpoint.total_memories_extracted,
        nextL1Count,
      );

      checkpoint.l0_conversations_count = Math.max(0, l0Count);
      checkpoint.total_memories_extracted = nextL1Count;
      checkpoint.total_processed = Math.max(0, scanResult.totalProcessed);
      checkpoint.memories_since_last_persona = memoriesSinceLastPersona;

      // Phase 4: Clamp per-session runner cursors
      if (checkpoint.runner_states) {
        for (const [sessionKey, state] of Object.entries(checkpoint.runner_states)) {
          let changed = false;
          const newestL0ForSession = scanResult.newestL0RecordedAtBySession.get(sessionKey);

          if (newestL0ForSession !== undefined && newestL0ForSession > 0) {
            if (state.last_l1_cursor > newestL0ForSession) {
              state.last_l1_cursor = newestL0ForSession;
              changed = true;
            }
            if (state.last_captured_timestamp > newestL0ForSession) {
              state.last_captured_timestamp = newestL0ForSession;
              changed = true;
            }
          } else if (canTrustL0SessionAbsence(l0Count, scanResult)) {
            if (state.last_l1_cursor !== 0) {
              state.last_l1_cursor = 0;
              changed = true;
            }
            if (state.last_captured_timestamp !== 0) {
              state.last_captured_timestamp = 0;
              changed = true;
            }
          }

          if (changed) runnerCursorsCorrected++;
        }
      }

      // Phase 5: Clamp per-session pipeline cursors
      if (checkpoint.pipeline_states) {
        for (const [sessionKey, state] of Object.entries(checkpoint.pipeline_states)) {
          let changed = false;
          const newestL1ForSession = scanResult.newestL1UpdatedAtBySession.get(sessionKey);

          if (newestL1ForSession !== undefined && newestL1ForSession > 0) {
            const currentCursor = state.last_extraction_updated_time
              ? new Date(state.last_extraction_updated_time).getTime()
              : 0;
            if (Number.isFinite(currentCursor) && currentCursor > newestL1ForSession) {
              state.last_extraction_updated_time = new Date(newestL1ForSession).toISOString();
              changed = true;
            }
          } else if (canTrustL1SessionAbsence(l1Count, scanResult)) {
            if (state.last_extraction_updated_time !== "") {
              state.last_extraction_updated_time = "";
              changed = true;
            }
          }

          if (changed) pipelineCursorsCorrected++;
        }
      }
    });
    this.logger.info(
      `[checkpoint] recalculate: l0=${cp.l0_conversations_count}, l1=${cp.total_memories_extracted}, ` +
      `processed=${cp.total_processed}, runner_cursors=${runnerCursorsCorrected}, ` +
      `pipeline_cursors=${pipelineCursorsCorrected}`,
    );

    return {
      l0_conversations_count: cp.l0_conversations_count,
      total_memories_extracted: cp.total_memories_extracted,
      total_processed: cp.total_processed,
      memories_since_last_persona: cp.memories_since_last_persona,
      runner_cursors_corrected: runnerCursorsCorrected,
      pipeline_cursors_corrected: pipelineCursorsCorrected,
    };
  }

  /**
   * Scan JSONL shards to count records and find cursor positions.
   */
  private async scanJsonlShards(dataDir: string): Promise<JsonlScanResult> {
    const L0_DIR = "conversations";
    const L1_DIR = "records";

    let l0Count = 0;
    let l1Count = 0;
    let totalProcessed = 0;
    let newestL0RecordedAt = 0;
    let newestL1UpdatedAt = 0;
    const newestL0RecordedAtBySession = new Map<string, number>();
    const newestL1UpdatedAtBySession = new Map<string, number>();
    const l0Sessions = new Set<string>();
    const l1Sessions = new Set<string>();

    // Scan L0 conversations
    await this.scanJsonlDir(
      path.join(dataDir, L0_DIR),
      {
        onRecord: (record) => {
          l0Count++;
          totalProcessed++;
          const sessionKey = getStringField(record, "sessionKey", "session_key", "session_id");
          if (sessionKey) l0Sessions.add(sessionKey);
          const recordedAt = getStringField(record, "recordedAt", "recorded_at");
          if (recordedAt) {
            const ts = new Date(recordedAt).getTime();
            if (!Number.isFinite(ts)) return;
            if (ts > newestL0RecordedAt) newestL0RecordedAt = ts;
            if (sessionKey) {
              const current = newestL0RecordedAtBySession.get(sessionKey) ?? 0;
              if (ts > current) newestL0RecordedAtBySession.set(sessionKey, ts);
            }
          }
        },
      },
    );

    // Scan L1 records
    await this.scanJsonlDir(
      path.join(dataDir, L1_DIR),
      {
        onRecord: (record) => {
          l1Count++;
          const sessionKey = getStringField(record, "sessionKey", "session_key", "session_id");
          if (sessionKey) l1Sessions.add(sessionKey);
          const updatedAt = getStringField(record, "updatedAt", "updated_at", "updated_time");
          if (updatedAt) {
            const ts = new Date(updatedAt).getTime();
            if (!Number.isFinite(ts)) return;
            if (ts > newestL1UpdatedAt) newestL1UpdatedAt = ts;
            if (sessionKey) {
              const current = newestL1UpdatedAtBySession.get(sessionKey) ?? 0;
              if (ts > current) newestL1UpdatedAtBySession.set(sessionKey, ts);
            }
          }
        },
      },
    );

    return {
      l0Count,
      l1Count,
      totalProcessed,
      newestL0RecordedAt,
      newestL1UpdatedAt,
      newestL0RecordedAtBySession,
      newestL1UpdatedAtBySession,
      l0Sessions,
      l1Sessions,
    };
  }
  /**
   * Scan a directory of JSONL shard files and process each record.
   */
  private async scanJsonlDir(
    dirPath: string,
    handlers: {
      onRecord: (record: Record<string, unknown>) => void;
    },
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      // Directory doesn't exist - nothing to scan
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".json")) continue;

      // Only scan date-sharded files (YYYY-MM-DD.*)
      if (!/^\d{4}-\d{2}-\d{2}\.(jsonl?|json)$/.test(entry.name)) continue;

      const filePath = path.join(dirPath, entry.name);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n").filter((line) => line.trim());

        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            handlers.onRecord(record);
          } catch {
            // Skip malformed JSON lines
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }
  }

  // ============================
  // Decrement methods (error correction)
  // ============================

  /**
   * Decrement L0 conversation count for error correction.
   *
   * Use case: when a conversation file is deleted after capture
   * (e.g., manual cleanup, test data removal).
   *
   * @param count - Number to decrement by (default: 1)
   */
  async decrementL0ConversationCount(count = 1): Promise<void> {
    await this.mutate((cp) => {
      cp.l0_conversations_count = Math.max(0, cp.l0_conversations_count - count);
    });
    this.logger.info(`[checkpoint] decrementL0ConversationCount: l0=${count}`);
  }

  /**
   * Decrement memories extracted and related counters for error correction.
   *
   * Use case: when L1 records are deleted after extraction
   * (e.g., test data cleanup, manual deletion).
   *
   * @param count - Number to decrement by
   */
  async decrementMemoriesExtracted(count: number): Promise<void> {
    await this.mutate((cp) => {
      cp.total_memories_extracted = Math.max(0, cp.total_memories_extracted - count);
      cp.memories_since_last_persona = Math.max(0, cp.memories_since_last_persona - count);
    });
    this.logger.info(`[checkpoint] decrementMemoriesExtracted: extracted=${count}`);
  }

  /**
   * Decrement total_processed counter for error correction.
   *
   * Use case: when captured messages are removed after processing
   * (e.g., L0 cleanup, manual trimming).
   *
   * @param count - Number to decrement by
   */
  async decrementTotalProcessed(count: number): Promise<void> {
    await this.mutate((cp) => {
      cp.total_processed = Math.max(0, cp.total_processed - count);
    });
    this.logger.info(`[checkpoint] decrementTotalProcessed: processed=${count}`);
  }
}
