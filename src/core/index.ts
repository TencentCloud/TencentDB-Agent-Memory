/**
 * TDAI Core — barrel re-export for core types and service facade.
 *
 * This module exports ONLY the host-neutral interfaces and the TdaiCore facade.
 * Host-specific adapters live in `../adapters/`.
 */

// Types & interfaces
export type {
  Logger,
  RuntimeContext,
  LLMRunParams,
  LLMRunner,
  LLMRunnerCreateOptions,
  LLMRunnerFactory,
  HostAdapter,
  CompletedTurn,
  RecalledMemory,
  RecallResult,
  CaptureResult,
  MemorySearchParams,
  ConversationSearchParams,
} from "./types.js";

// TdaiCore service facade
export { TdaiCore } from "./tdai-core.js";
export type { TdaiCoreOptions } from "./tdai-core.js";
