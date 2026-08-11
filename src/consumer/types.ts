/**
 * tz-08 — the memory CONSUMER port.
 *
 * Two boundaries make this system host-agnostic, and they are independent:
 * the producer (a role, behind `RoleLauncher`) and the consumer (a session
 * that reads recall and writes a note). This file is the consumer half.
 *
 * The port is deliberately tiny — two operations, fixed on every host. A host
 * that cannot offer one of them is declared incompatible out loud
 * (`incompatible-host`); it never ships a quietly smaller set (D1b).
 *
 * Failures are VALUES, not exceptions: an unreachable gateway must not take
 * the user's session down with it, and — more importantly — must never look
 * like an empty result. An empty list reads as "memory holds nothing", so the
 * session writes down what it already knows, and that is how duplicates are
 * born (ТЗ R2/S4).
 */

/** Why a call did not produce an answer. Each kind is separately actionable. */
export type ConsumerFailureKind =
  /** The write-gate refused the credential (or none was presented). */
  | "unauthorized"
  /** Nothing answered: connection refused, DNS, timeout, socket dropped. */
  | "unavailable"
  /** The server understood and refused: missing query, empty note, too long. */
  | "bad-request"
  /**
   * Memory is rebuilding its index. The server answers 200 with an empty
   * result and `gated: true` (memory-tools.ts:51-53) — the ONE case where a
   * successful HTTP status still means "no answer available right now".
   */
  | "gated"
  /** The server broke on its own side (5xx, unparseable body). */
  | "server-error";

export interface ConsumerFailure {
  ok: false;
  kind: ConsumerFailureKind;
  /** Human-readable, safe to show a user. Never carries the credential. */
  message: string;
}

export type ConsumerResult<T> = ({ ok: true } & T) | ConsumerFailure;

export interface SearchInput {
  query: string;
  /** Server clamps to 1..50 (default 5). The client passes it through as-is:
   * clamping here would be a second copy of a server rule (D1a). */
  limit?: number;
  type?: string;
  scene?: string;
}

export interface SearchOk {
  /** Rendered result text, exactly as the server produced it. */
  results: string;
  total: number;
  /** Which search the server ran: `hybrid`, `fts`, `embedding`, `none`. */
  strategy: string;
}

export interface NoteInput {
  content: string;
  sessionKey?: string;
  projectId?: string;
}

export interface NoteOk {
  l0Recorded: number;
  schedulerNotified: boolean;
  sessionKey: string;
}

/**
 * What every host gets, unchanged. Reading needs no credential; writing goes
 * through the gate. The implementation is transport — it adds no ranking, no
 * filtering, no caching and no truncation of its own.
 */
export interface MemoryConsumer {
  search(input: SearchInput): Promise<ConsumerResult<SearchOk>>;
  note(input: NoteInput): Promise<ConsumerResult<NoteOk>>;
}

/** Default call budget. A transport is allowed to give up; it is not allowed
 * to hang a session waiting (ТЗ: недоступность не роняет сессию). */
export const DEFAULT_TIMEOUT_MS = 5_000;
