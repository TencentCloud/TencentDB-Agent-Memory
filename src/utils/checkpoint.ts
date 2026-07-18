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

export interface CheckpointLogger {
  info(msg: string): void;
  warn?(msg: string): void;
}

const noopLogger: CheckpointLogger = { info() {} };

export interface CheckpointRecalculateOptions {
  /**
   * Optional primary store. When available, L0/L1 counts follow the same
   * source used by the live incremental pipeline; JSONL is still scanned as a
   * fallback and as a cursor-safety source.
   */
  vectorStore?: Pick<
    IMemoryStore,
    "isDegraded" | "countL0" | "countL1" | "queryL0GroupedBySessionId" | "queryL1Records"
  >;
  /**
   * Also clamp per-session incremental cursors down to the newest record that
   * still exists in storage. This is intended for cleanup/reset/rollback flows
   * where the checkpoint may point past the retained data.
   */
  repairCursors?: boolean;
}

export interface CheckpointCursorRepairOptions {
  /**
   * Optional primary store. JSONL is still scanned as a fallback and as a
   * cursor-safety source.
   */
  vectorStore?: CheckpointRecalculateOptions["vectorStore"];
}

export interface CheckpointRecalculateResult {
  before: Pick<
    Checkpoint,
    "total_processed" | "l0_conversations_count" | "total_memories_extracted" |
    "memories_since_last_persona" | "scenes_processed"
  >;
  after: Pick<
    Checkpoint,
    "total_processed" | "l0_conversations_count" | "total_memories_extracted" |
    "memories_since_last_persona" | "scenes_processed"
  >;
  storage: {
    l0MessageCount: number;
    l0BatchCount: number;
    l1RecordCount: number;
    memoriesSinceLastPersona: number;
    sceneCount: number;
    l0Source: "vectorStore" | "jsonl" | "none";
    l1Source: "vectorStore" | "jsonl" | "none";
  };
  repairedCursors: number;
}

export interface CheckpointCursorSnapshot {
  last_captured_timestamp: number;
  runner_states: Record<string, Pick<RunnerSessionState, "last_captured_timestamp" | "last_l1_cursor">>;
  pipeline_states: Record<string, Pick<PipelineSessionState, "last_extraction_updated_time">>;
}

export interface CheckpointCursorRepairResult {
  before: CheckpointCursorSnapshot;
  after: CheckpointCursorSnapshot;
  storage: Pick<
    CheckpointRecalculateResult["storage"],
    "l0MessageCount" | "l1RecordCount" | "l0Source" | "l1Source"
  >;
  repairedCursors: number;
}

interface StorageStats {
  l0MessageCount: number;
  l0BatchCount: number;
  l1RecordCount: number;
  memoriesSinceLastPersona: number;
  sceneCount: number;
  l0Source: "vectorStore" | "jsonl" | "none";
  l1Source: "vectorStore" | "jsonl" | "none";
  l0MaxMessageTimestampBySession: Map<string, number>;
  l0MaxRecordedAtMsBySession: Map<string, number>;
  l1MaxUpdatedAtBySession: Map<string, string>;
}

interface L0ScanStats {
  messageCount: number;
  batchCount: number;
  maxMessageTimestampBySession: Map<string, number>;
  maxRecordedAtMsBySession: Map<string, number>;
}

interface L1ScanStats {
  recordCount: number;
  memoriesSinceLastPersona: number;
  maxUpdatedAtBySession: Map<string, string>;
}

const RECALCULATE_QUERY_LIMIT = 1_000_000;

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

function setMaxNumber(map: Map<string, number>, key: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) return;
  const current = map.get(key) ?? 0;
  if (value > current) {
    map.set(key, value);
  }
}

function setMaxString(map: Map<string, string>, key: string, value: string): void {
  if (!value) return;
  const current = map.get(key) ?? "";
  if (value > current) {
    map.set(key, value);
  }
}

function mergeMaxNumberMaps(...maps: Array<Map<string, number>>): Map<string, number> {
  const merged = new Map<string, number>();
  for (const map of maps) {
    for (const [key, value] of map) {
      setMaxNumber(merged, key, value);
    }
  }
  return merged;
}

function mergeMaxStringMaps(...maps: Array<Map<string, string>>): Map<string, string> {
  const merged = new Map<string, string>();
  for (const map of maps) {
    for (const [key, value] of map) {
      setMaxString(merged, key, value);
    }
  }
  return merged;
}

function counterSnapshot(cp: Checkpoint): CheckpointRecalculateResult["before"] {
  return {
    total_processed: cp.total_processed,
    l0_conversations_count: cp.l0_conversations_count,
    total_memories_extracted: cp.total_memories_extracted,
    memories_since_last_persona: cp.memories_since_last_persona,
    scenes_processed: cp.scenes_processed,
  };
}

function cursorSnapshot(cp: Checkpoint): CheckpointCursorSnapshot {
  const runner_states: CheckpointCursorSnapshot["runner_states"] = {};
  for (const [key, state] of Object.entries(cp.runner_states ?? {})) {
    runner_states[key] = {
      last_captured_timestamp: state.last_captured_timestamp,
      last_l1_cursor: state.last_l1_cursor,
    };
  }

  const pipeline_states: CheckpointCursorSnapshot["pipeline_states"] = {};
  for (const [key, state] of Object.entries(cp.pipeline_states ?? {})) {
    pipeline_states[key] = {
      last_extraction_updated_time: state.last_extraction_updated_time,
    };
  }

  return {
    last_captured_timestamp: cp.last_captured_timestamp,
    runner_states,
    pipeline_states,
  };
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

  /**
   * Recalculate aggregate checkpoint counters from the data that actually
   * exists on disk / in the primary store.
   *
   * This repairs drift after retention cleanup, manual JSONL trimming, session
   * reset, or historical rollback. With `repairCursors=true`, per-session
   * incremental cursors are also clamped to the newest retained record so the
   * next incremental pass does not skip records that were rolled back.
   */
  async recalculateFromStorage(
    options: CheckpointRecalculateOptions = {},
  ): Promise<CheckpointRecalculateResult> {
    return withFileLock(this.filePath, async () => {
      const cp = await this.readRaw();
      const before = counterSnapshot(cp);
      const stats = await this.collectStorageStats(cp, options);

      cp.total_processed = stats.l0MessageCount;
      cp.l0_conversations_count = stats.l0BatchCount;
      cp.total_memories_extracted = stats.l1RecordCount;
      cp.memories_since_last_persona = stats.memoriesSinceLastPersona;
      cp.scenes_processed = stats.sceneCount;
      if (cp.last_persona_at > cp.total_processed) {
        cp.last_persona_at = cp.total_processed;
      }

      const repairedCursors = options.repairCursors
        ? this.repairIncrementalCursors(cp, stats)
        : 0;

      await this.writeRaw(cp);
      const after = counterSnapshot(cp);

      this.logger.info(
        `[checkpoint] recalculateFromStorage: ` +
        `L0 messages=${stats.l0MessageCount} (${stats.l0Source}), ` +
        `L0 batches=${stats.l0BatchCount}, ` +
        `L1 records=${stats.l1RecordCount} (${stats.l1Source}), ` +
        `memories_since_persona=${stats.memoriesSinceLastPersona}, ` +
        `scenes=${stats.sceneCount}, repairedCursors=${repairedCursors}`,
      );

      return {
        before,
        after,
        storage: {
          l0MessageCount: stats.l0MessageCount,
          l0BatchCount: stats.l0BatchCount,
          l1RecordCount: stats.l1RecordCount,
          memoriesSinceLastPersona: stats.memoriesSinceLastPersona,
          sceneCount: stats.sceneCount,
          l0Source: stats.l0Source,
          l1Source: stats.l1Source,
        },
        repairedCursors,
      };
    });
  }

  /**
   * Repair only stale incremental cursors, leaving aggregate counters untouched.
   *
   * A cursor is considered stale when it points past the newest record that
   * still exists in storage. This can happen after retention cleanup, manual
   * JSONL trimming, session reset, or historical rollback. Clamping these
   * cursors back to the retained data boundary prevents future backfilled or
   * restored records from being filtered out by an unreachable old checkpoint.
   */
  async repairStaleCursorsFromStorage(
    options: CheckpointCursorRepairOptions = {},
  ): Promise<CheckpointCursorRepairResult> {
    return withFileLock(this.filePath, async () => {
      const cp = await this.readRaw();
      const before = cursorSnapshot(cp);
      const stats = await this.collectStorageStats(cp, { vectorStore: options.vectorStore });
      const repairedCursors = this.repairIncrementalCursors(cp, stats);

      if (repairedCursors > 0) {
        await this.writeRaw(cp);
      }

      const after = cursorSnapshot(cp);
      this.logger.info(
        `[checkpoint] repairStaleCursorsFromStorage: ` +
        `L0 messages=${stats.l0MessageCount} (${stats.l0Source}), ` +
        `L1 records=${stats.l1RecordCount} (${stats.l1Source}), ` +
        `repairedCursors=${repairedCursors}`,
      );

      return {
        before,
        after,
        storage: {
          l0MessageCount: stats.l0MessageCount,
          l1RecordCount: stats.l1RecordCount,
          l0Source: stats.l0Source,
          l1Source: stats.l1Source,
        },
        repairedCursors,
      };
    });
  }

  private async collectStorageStats(
    cp: Checkpoint,
    options: CheckpointRecalculateOptions,
  ): Promise<StorageStats> {
    const jsonlL0 = await this.scanL0Jsonl();
    const jsonlL1 = await this.scanL1Jsonl(cp.last_persona_time);
    const sceneCount = await this.countSceneBlocks();
    const jsonlSessionKeys = new Set<string>([
      ...jsonlL0.maxMessageTimestampBySession.keys(),
      ...jsonlL0.maxRecordedAtMsBySession.keys(),
      ...jsonlL1.maxUpdatedAtBySession.keys(),
    ]);
    const vector = await this.scanVectorStore(cp, options.vectorStore, jsonlSessionKeys);

    const l0Source = vector ? "vectorStore" : jsonlL0.messageCount > 0 ? "jsonl" : "none";
    const l1Source = vector ? "vectorStore" : jsonlL1.recordCount > 0 ? "jsonl" : "none";

    const l0MessageCount = vector?.l0.messageCount ?? jsonlL0.messageCount;
    const l0BatchCount = jsonlL0.batchCount > 0
      ? jsonlL0.batchCount
      : vector?.l0.batchCount ?? (l0MessageCount > 0 ? l0MessageCount : 0);
    const l1RecordCount = vector?.l1.recordCount ?? jsonlL1.recordCount;
    const memoriesSinceLastPersona = vector?.l1.memoriesSinceLastPersona
      ?? jsonlL1.memoriesSinceLastPersona;

    return {
      l0MessageCount,
      l0BatchCount,
      l1RecordCount,
      memoriesSinceLastPersona,
      sceneCount,
      l0Source,
      l1Source,
      // Use the union of primary and fallback maxima to avoid rewinding cursors
      // behind data that still exists in either store.
      l0MaxMessageTimestampBySession: mergeMaxNumberMaps(
        jsonlL0.maxMessageTimestampBySession,
        vector?.l0.maxMessageTimestampBySession ?? new Map(),
      ),
      l0MaxRecordedAtMsBySession: mergeMaxNumberMaps(
        jsonlL0.maxRecordedAtMsBySession,
        vector?.l0.maxRecordedAtMsBySession ?? new Map(),
      ),
      l1MaxUpdatedAtBySession: mergeMaxStringMaps(
        jsonlL1.maxUpdatedAtBySession,
        vector?.l1.maxUpdatedAtBySession ?? new Map(),
      ),
    };
  }

  private async scanVectorStore(
    cp: Checkpoint,
    vectorStore: CheckpointRecalculateOptions["vectorStore"],
    additionalSessionKeys: Set<string>,
  ): Promise<{ l0: L0ScanStats; l1: L1ScanStats } | undefined> {
    if (!vectorStore || vectorStore.isDegraded()) {
      return undefined;
    }

    const l0: L0ScanStats = {
      messageCount: 0,
      batchCount: 0,
      maxMessageTimestampBySession: new Map(),
      maxRecordedAtMsBySession: new Map(),
    };
    const l1: L1ScanStats = {
      recordCount: 0,
      memoriesSinceLastPersona: 0,
      maxUpdatedAtBySession: new Map(),
    };

    try {
      l0.messageCount = await vectorStore.countL0();
    } catch (err) {
      this.logger.warn?.(`[checkpoint] recalculate: countL0 failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const batchKeys = new Set<string>();
    let queriedL0Messages = 0;
    for (const sessionKey of this.getKnownSessionKeys(cp, additionalSessionKeys)) {
      try {
        const groups = await vectorStore.queryL0GroupedBySessionId(
          sessionKey,
          undefined,
          RECALCULATE_QUERY_LIMIT,
        );
        for (const group of groups) {
          for (const message of group.messages) {
            queriedL0Messages += 1;
            setMaxNumber(l0.maxMessageTimestampBySession, sessionKey, message.timestamp);
            setMaxNumber(l0.maxRecordedAtMsBySession, sessionKey, message.recordedAtMs);
            if (message.recordedAtMs > 0) {
              batchKeys.add(`${sessionKey}\0${group.sessionId}\0${message.recordedAtMs}`);
            }
          }
        }
      } catch (err) {
        this.logger.warn?.(
          `[checkpoint] recalculate: queryL0GroupedBySessionId failed for ${sessionKey}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (l0.messageCount === 0 && queriedL0Messages > 0) {
      l0.messageCount = queriedL0Messages;
    }
    l0.batchCount = batchKeys.size;

    let l1Rows: Awaited<ReturnType<IMemoryStore["queryL1Records"]>> = [];
    try {
      l1Rows = await vectorStore.queryL1Records({});
    } catch (err) {
      this.logger.warn?.(`[checkpoint] recalculate: queryL1Records failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      l1.recordCount = await vectorStore.countL1();
    } catch (err) {
      this.logger.warn?.(`[checkpoint] recalculate: countL1 failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (l1.recordCount === 0 && l1Rows.length > 0) {
      l1.recordCount = l1Rows.length;
    }

    for (const row of l1Rows) {
      const sessionKey = row.session_key || "";
      if (!sessionKey) continue;
      const updated = row.updated_time || row.created_time || "";
      setMaxString(l1.maxUpdatedAtBySession, sessionKey, updated);
      if (!cp.last_persona_time || updated > cp.last_persona_time) {
        l1.memoriesSinceLastPersona += 1;
      }
    }
    if (l1Rows.length === 0 && l1.recordCount > 0 && !cp.last_persona_time) {
      l1.memoriesSinceLastPersona = l1.recordCount;
    }

    return { l0, l1 };
  }

  private getKnownSessionKeys(cp: Checkpoint, additionalSessionKeys: Set<string>): string[] {
    const keys = new Set<string>(additionalSessionKeys);
    for (const key of Object.keys(cp.runner_states ?? {})) keys.add(key);
    for (const key of Object.keys(cp.pipeline_states ?? {})) keys.add(key);
    return Array.from(keys).filter(Boolean).sort();
  }

  private async scanL0Jsonl(): Promise<L0ScanStats> {
    const stats: L0ScanStats = {
      messageCount: 0,
      batchCount: 0,
      maxMessageTimestampBySession: new Map(),
      maxRecordedAtMsBySession: new Map(),
    };
    const batchKeys = new Set<string>();

    await this.forEachJsonRecord("conversations", (record) => {
      const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : "";
      if (!sessionKey) return;
      const recordedAt = typeof record.recordedAt === "string" ? record.recordedAt : "";
      const recordedAtMs = Date.parse(recordedAt) || 0;
      const messageTs = typeof record.timestamp === "number" ? record.timestamp : 0;
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";

      stats.messageCount += 1;
      setMaxNumber(stats.maxMessageTimestampBySession, sessionKey, messageTs);
      setMaxNumber(stats.maxRecordedAtMsBySession, sessionKey, recordedAtMs);
      if (recordedAt) {
        batchKeys.add(`${sessionKey}\0${sessionId}\0${recordedAt}`);
      }
    });

    stats.batchCount = batchKeys.size;
    return stats;
  }

  private async scanL1Jsonl(lastPersonaTime: string): Promise<L1ScanStats> {
    const stats: L1ScanStats = {
      recordCount: 0,
      memoriesSinceLastPersona: 0,
      maxUpdatedAtBySession: new Map(),
    };

    await this.forEachJsonRecord("records", (record) => {
      const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : "";
      if (!sessionKey) return;
      const updated = typeof record.updatedAt === "string"
        ? record.updatedAt
        : typeof record.createdAt === "string"
          ? record.createdAt
          : "";

      stats.recordCount += 1;
      setMaxString(stats.maxUpdatedAtBySession, sessionKey, updated);
      if (!lastPersonaTime || updated > lastPersonaTime) {
        stats.memoriesSinceLastPersona += 1;
      }
    });

    return stats;
  }

  private async forEachJsonRecord(
    subdir: "conversations" | "records",
    fn: (record: Record<string, unknown>) => void,
  ): Promise<void> {
    const dir = path.join(this.dataDir, subdir);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json")))
      .map((entry) => entry.name)
      .sort();

    for (const fileName of files) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, fileName), "utf-8");
      } catch {
        continue;
      }

      const trimmed = raw.trim();
      if (!trimmed) continue;

      if (fileName.endsWith(".json") && (trimmed.startsWith("[") || trimmed.startsWith("{"))) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          const records = Array.isArray(parsed) ? parsed : [parsed];
          for (const record of records) {
            if (record && typeof record === "object") {
              fn(record as Record<string, unknown>);
            }
          }
          continue;
        } catch {
          // Fall through to line-by-line parsing; some .json files are JSONL.
        }
      }

      for (const line of raw.split("\n")) {
        const lineTrimmed = line.trim();
        if (!lineTrimmed) continue;
        try {
          const record = JSON.parse(lineTrimmed) as unknown;
          if (record && typeof record === "object") {
            fn(record as Record<string, unknown>);
          }
        } catch {
          // Ignore malformed lines during repair; normal readers already log them.
        }
      }
    }
  }

  private async countSceneBlocks(): Promise<number> {
    const dir = path.join(this.dataDir, "scene_blocks");
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
    } catch {
      return 0;
    }
  }

  private repairIncrementalCursors(cp: Checkpoint, stats: StorageStats): number {
    let repaired = 0;
    let globalMaxCapturedTimestamp = 0;
    for (const value of stats.l0MaxMessageTimestampBySession.values()) {
      if (value > globalMaxCapturedTimestamp) globalMaxCapturedTimestamp = value;
    }

    if (cp.last_captured_timestamp > globalMaxCapturedTimestamp) {
      cp.last_captured_timestamp = globalMaxCapturedTimestamp;
      repaired += 1;
    }

    for (const [sessionKey, state] of Object.entries(cp.runner_states ?? {})) {
      const maxCaptured = stats.l0MaxMessageTimestampBySession.get(sessionKey) ?? 0;
      if (state.last_captured_timestamp > maxCaptured) {
        state.last_captured_timestamp = maxCaptured;
        repaired += 1;
      }

      const maxRecordedAt = stats.l0MaxRecordedAtMsBySession.get(sessionKey) ?? 0;
      if (state.last_l1_cursor > maxRecordedAt) {
        state.last_l1_cursor = maxRecordedAt;
        repaired += 1;
      }
    }

    for (const [sessionKey, state] of Object.entries(cp.pipeline_states ?? {})) {
      const maxUpdatedAt = stats.l1MaxUpdatedAtBySession.get(sessionKey) ?? "";
      if (state.last_extraction_updated_time && state.last_extraction_updated_time > maxUpdatedAt) {
        state.last_extraction_updated_time = maxUpdatedAt;
        repaired += 1;
      }
    }

    return repaired;
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

  async decrementTotalProcessed(amount = 1): Promise<void> {
    const delta = Math.max(0, Math.floor(amount));
    if (delta === 0) return;
    const cp = await this.mutate((cp) => {
      cp.total_processed = Math.max(0, cp.total_processed - delta);
      cp.last_persona_at = Math.min(cp.last_persona_at, cp.total_processed);
    });
    this.logger.info(`[checkpoint] decrementTotalProcessed: total_processed=${cp.total_processed}`);
  }

  async decrementL0ConversationCount(amount = 1): Promise<void> {
    const delta = Math.max(0, Math.floor(amount));
    if (delta === 0) return;
    const cp = await this.mutate((cp) => {
      cp.l0_conversations_count = Math.max(0, cp.l0_conversations_count - delta);
    });
    this.logger.info(`[checkpoint] decrementL0ConversationCount: l0_conversations_count=${cp.l0_conversations_count}`);
  }

  async decrementTotalMemoriesExtracted(amount = 1): Promise<void> {
    const delta = Math.max(0, Math.floor(amount));
    if (delta === 0) return;
    const cp = await this.mutate((cp) => {
      cp.total_memories_extracted = Math.max(0, cp.total_memories_extracted - delta);
      cp.memories_since_last_persona = Math.max(0, cp.memories_since_last_persona - delta);
    });
    this.logger.info(
      `[checkpoint] decrementTotalMemoriesExtracted: total_memories_extracted=${cp.total_memories_extracted}, ` +
      `memories_since_last_persona=${cp.memories_since_last_persona}`,
    );
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

}
