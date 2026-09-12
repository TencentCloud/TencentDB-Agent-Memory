/**
 * TDAI Adapter SDK — barrel export.
 *
 * New Agent platforms import from here:
 *
 * ```ts
 * import {
 *   type MemoryAdapter,
 *   HttpMemoryAdapter,
 *   InProcessMemoryAdapter,
 *   fromCore,
 * } from "src/adapters/sdk";
 * ```
 *
 * See `docs/adapters/ARCHITECTURE.md` for the platform-integration guide.
 */

export type {
  CaptureTurn,
  MemorySearchOutcome,
  ConversationSearchOutcome,
  HealthCheckResult,
  MemoryAdapter,
} from "./types.js";
export { MemoryAdapterError } from "./types.js";

export { HttpMemoryAdapter } from "./http-memory-adapter.js";
export type { HttpMemoryAdapterOptions } from "./http-memory-adapter.js";

export { InProcessMemoryAdapter, fromCore } from "./in-process-memory-adapter.js";
export type {
  InProcessMemoryAdapterOptions,
  TdaiCoreLike,
} from "./in-process-memory-adapter.js";
