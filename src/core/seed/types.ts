/**
 * Shared type definitions for the `seed` command.
 *
 * Covers:
 * - Raw input shapes (Format A / B / JSONL)
 * - Normalized internal structures
 * - Validation error descriptors
 */

// ============================
// Raw input types (before validation)
// ============================

/** A single message in a conversation round. */
export interface RawMessage {
  /** Optional stable message ID. Useful for idempotent historical imports. */
  id?: string;
  role: string;
  content: string;
  /**
   * Epoch milliseconds (number) **or** ISO 8601 string (e.g. `"2024-04-01T12:00:00Z"`).
   * ISO strings are parsed via `new Date()` during normalization and
   * stored internally as epoch ms.
   */
  timestamp?: number | string;
}

/** A single session entry (shared between Format A wrapper and Format B array). */
export interface RawSession {
  sessionKey: string;
  sessionId?: string;
  conversations: RawMessage[][];
}

/** Format A: `{ sessions: [...] }` */
export interface FormatA {
  sessions: RawSession[];
}

/** Format B: `[...]` (top-level array of sessions) */
export type FormatB = RawSession[];

// ============================
// Normalized types (after validation)
// ============================

export interface NormalizedMessage {
  /** Stable message ID when provided by the input. */
  id?: string;
  role: string;
  content: string;
  /** Epoch ms — always present after normalization (filled if originally missing). */
  timestamp: number;
}

export interface NormalizedRound {
  messages: NormalizedMessage[];
}

export interface NormalizedSession {
  sessionKey: string;
  sessionId: string;
  rounds: NormalizedRound[];
  /** Index in the original input array (for progress reporting). */
  sourceIndex: number;
}

export interface NormalizedInput {
  sessions: NormalizedSession[];
  /** Total number of rounds across all sessions. */
  totalRounds: number;
  /** Total number of messages across all sessions. */
  totalMessages: number;
  /** Whether timestamps were present in the original input. */
  hasTimestamps: boolean;
}

// ============================
// Validation
// ============================

/** Stages where a validation error can occur. */
export type ValidationStage =
  | "file"
  | "top_level"
  | "session"
  | "round"
  | "message"
  | "timestamp_consistency";

/** A single validation error with location context. */
export interface ValidationError {
  stage: ValidationStage;
  sourceIndex?: number;
  sessionKey?: string;
  roundIndex?: number;
  messageIndex?: number;
  message: string;
}

// ============================
// Seed command options (from CLI)
// ============================

export interface SeedCommandOptions {
  /** Path to input file (required). */
  input: string;
  /** Output directory (optional, auto-generated if missing). */
  outputDir?: string;
  /** Fallback session key when input lacks one. */
  sessionKey?: string;
  /** Strict round-role validation (each round must have user + assistant). */
  strictRoundRole: boolean;
  /** Skip interactive confirmations. */
  yes: boolean;
  /** Path to memory-tdai config override file (JSON, deep-merged on top of current plugin config). */
  configFile?: string;
  /** Wait for final L1→L2→L3 processing before returning. */
  waitForFullPipeline?: boolean;
  /** Wait for L1 at per-batch boundaries before feeding more rounds. */
  waitForL1?: boolean;
  /** Bounded L1 extraction concurrency for this seed run. */
  l1Concurrency?: number;
  /** Coalesce pending L2 records into batches during final full-pipeline flush. */
  l2BatchSize?: number;
  /** Max wait time for final L1→L2→L3 processing. */
  fullPipelineTimeoutMs?: number;
}

// ============================
// Seed runtime types
// ============================

/** Progress info emitted during seed execution. */
export interface SeedProgress {
  /** Current round index (1-based, across all sessions). */
  currentRound: number;
  /** Total rounds. */
  totalRounds: number;
  /** Current session key. */
  sessionKey: string;
  /** Current stage description. */
  stage: string;
}

/** Final summary after seed completes. */
export interface SeedSummary {
  sessionsProcessed: number;
  roundsProcessed: number;
  messagesProcessed: number;
  l0RecordedCount: number;
  /** True when the caller requested and completed a final L1→L2→L3 flush. */
  fullPipelineFlushed?: boolean;
  durationMs: number;
  outputDir: string;
}
