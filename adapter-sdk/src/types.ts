/**
 * TDAI Adapter SDK — Host-neutral type definitions.
 *
 * The whole point of this SDK is that a new Agent platform can be wired into
 * TencentDB Agent Memory by implementing ONE interface: {@link PlatformBinding}.
 *
 * Everything else (HTTP transport to the Gateway, session resolution, error
 * handling, tool orchestration) is provided by {@link MemoryAdapter} in
 * `adapter-core.ts`.
 *
 * Design:
 *   platform event (raw)  ──parse──▶  normalized input  ──▶  Gateway REST call
 *   Gateway REST result   ──format──▶  platform-native output
 *
 * The SDK talks ONLY to the existing HTTP Gateway (`src/gateway/server.ts`),
 * exactly like the Hermes provider does. It never imports TdaiCore, so it is
 * fully decoupled from the core engine's runtime.
 */

// ============================
// Normalized memory operations (mirror the Gateway REST contract)
// ============================

/** Normalized input for a recall (memory retrieval before a turn). */
export interface RecallInput {
  /** The user query / text to recall memories for. */
  query: string;
  /** Stable session key used for L0/L1 grouping. */
  sessionKey: string;
  /** Optional user identifier. */
  userId?: string;
}

/** Normalized recall result (mirrors Gateway `RecallResponse`). */
export interface RecallOutput {
  /** Recall context text to inject into the prompt (may be empty). */
  context: string;
  /** Search strategy that produced the result. */
  strategy?: string;
  /** Number of L1 memories recalled. */
  memoryCount: number;
}

/** Normalized input for a capture (conversation turn commit). */
export interface CaptureInput {
  /** The user's message text. */
  userContent: string;
  /** The assistant's response text. */
  assistantContent: string;
  /** Stable session key. */
  sessionKey: string;
  /** Optional sub-session id. */
  sessionId?: string;
  /** Optional user identifier. */
  userId?: string;
}

/** Normalized capture result (mirrors Gateway `CaptureResponse`). */
export interface CaptureOutput {
  /** Number of L0 messages recorded. */
  l0Recorded: number;
  /** Whether the pipeline scheduler was notified. */
  schedulerNotified: boolean;
}

/** Normalized input for ending a session (flush). */
export interface SessionEndInput {
  sessionKey: string;
  userId?: string;
}

/** Normalized input for an L1 memory search tool call. */
export interface MemorySearchInput {
  query: string;
  limit?: number;
  /** Optional memory type filter: persona | episodic | instruction. */
  type?: string;
  /** Optional scene name filter. */
  scene?: string;
}

/** Normalized input for an L0 conversation search tool call. */
export interface ConversationSearchInput {
  query: string;
  limit?: number;
  sessionKey?: string;
}

/** Normalized search result (mirrors Gateway search responses). */
export interface SearchOutput {
  /** Formatted, human/LLM-readable result text. */
  results: string;
  /** Total number of hits. */
  total: number;
  /** Strategy (only present for memory search). */
  strategy?: string;
}

// ============================
// Tool descriptors (platform-neutral)
// ============================

/** JSON-schema-ish tool descriptor, translated per platform. */
export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema object for the tool parameters. */
  parameters: Record<string, unknown>;
}

/** The two memory tools every platform can surface. */
export type ToolName = "memory_search" | "conversation_search";

// ============================
// Logger
// ============================

export interface AdapterLogger {
  debug?: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// ============================
// PlatformBinding — the ONE interface to implement per platform
// ============================

/**
 * A platform binding translates a specific Agent platform's native event
 * payloads into the SDK's normalized inputs, and formats normalized results
 * back into the shape the platform expects.
 *
 * Implement this interface (plus wire the platform's lifecycle events to the
 * matching `MemoryAdapter.handle*` methods) and the platform gains full
 * TencentDB Agent Memory read/write capability.
 *
 * Every `parse*` method may return `null` to signal "skip this event"
 * (e.g. an empty prompt, or a turn that should not be captured).
 *
 * Type parameters carry the platform's native payload/return shapes so the
 * binding stays fully typed end-to-end; default to `unknown`.
 */
export interface PlatformBinding<
  RawRecall = unknown,
  RawCapture = unknown,
  RawSessionEnd = unknown,
  RecallReturn = unknown,
  CaptureReturn = unknown,
> {
  /** Platform identifier, e.g. "claude-code", "codex". */
  readonly platform: string;

  /**
   * Optional tool-name overrides. Different platforms namespace tools
   * differently (e.g. OpenClaw uses `tdai_memory_search`, Hermes uses
   * `memory_tencentdb_memory_search`). Defaults to `memory_search` /
   * `conversation_search`.
   */
  readonly toolNames?: Partial<Record<ToolName, string>>;

  // -- recall (before a turn) --------------------------------------------
  /** Parse a native recall trigger; return null to skip recall. */
  parseRecall(raw: RawRecall): RecallInput | null;
  /** Format a recall result into the platform-native output shape. */
  formatRecall(result: RecallOutput, raw: RawRecall): RecallReturn;

  // -- capture (turn committed) ------------------------------------------
  /** Parse a native turn-end event; return null to skip capture. */
  parseCapture(raw: RawCapture): CaptureInput | null;
  /** Optional: format a capture result into platform output. */
  formatCapture?(result: CaptureOutput, raw: RawCapture): CaptureReturn;

  // -- session end (flush) -----------------------------------------------
  /** Parse a native session-end event; return null to skip flush. */
  parseSessionEnd(raw: RawSessionEnd): SessionEndInput | null;
}
