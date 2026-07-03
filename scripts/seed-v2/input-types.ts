/**
 * Type definitions for seed-v2 fixture input.
 *
 * ⚠️ 这份文件是从 `src/core/seed/types.ts` 拷来的精简版（去掉了 v1 CLI 专属的
 * `SeedCommandOptions` / `SeedProgress` / `SeedSummary`）。
 *
 * 老 v1 seed (`src/cli/commands/seed.ts` + `/seed` v1 endpoint) 计划废弃后，
 * 本文件成为唯一真理之源。在那之前，如果在 `src/core/seed/types.ts` 改了
 * Raw* / Normalized* / ValidationError，请同步到这里。
 */

// ============================
// Raw input types (before validation)
// ============================

export interface RawMessage {
  role: string;
  content: string;
  /** Epoch ms (number) or ISO 8601 string. */
  timestamp?: number | string;
}

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
  role: string;
  content: string;
  /** Epoch ms — always present after normalization. 0 means "to be filled later". */
  timestamp: number;
}

export interface NormalizedRound {
  messages: NormalizedMessage[];
}

export interface NormalizedSession {
  sessionKey: string;
  sessionId: string;
  rounds: NormalizedRound[];
  sourceIndex: number;
}

export interface NormalizedInput {
  sessions: NormalizedSession[];
  totalRounds: number;
  totalMessages: number;
  hasTimestamps: boolean;
}

// ============================
// Validation
// ============================

export type ValidationStage =
  | "file"
  | "top_level"
  | "session"
  | "round"
  | "message"
  | "timestamp_consistency";

export interface ValidationError {
  stage: ValidationStage;
  sourceIndex?: number;
  sessionKey?: string;
  roundIndex?: number;
  messageIndex?: number;
  message: string;
}
