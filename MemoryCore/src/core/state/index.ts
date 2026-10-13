/**
 * Public state backend factory. Local state is in memory; Redis is unsupported
 * because this distribution does not ship a Redis state implementation.
 * Explicit selection prevents accidental fallback to volatile local state.
 */

export type {
  IStateBackend,
  PipelineSessionState,
  TimerEntry,
  TaskPayload,
  CaptureAtomicParams,
  CaptureAtomicResult,
} from "./types.js";
export { DEFAULT_PIPELINE_STATE } from "./types.js";

export { LocalStateBackend } from "./local-backend.js";

import type { IStateBackend, TimerEntry } from "./types.js";
import { LocalStateBackend } from "./local-backend.js";

export interface StateBackendConfig {
  type: "local" | "redis";
  local?: {
    onTimerExpired?: (entry: TimerEntry) => void;
  };
  redis?: {
    /** backend connection URL */
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    /** database index (default: 0) */
    db?: number;
    keyPrefix?: string;
    consumerGroup?: string;
  };
}

/** Create the explicitly selected public state backend. */
export async function createStateBackend(config: StateBackendConfig): Promise<IStateBackend> {
  if (config.type === "redis") {
    throw new Error("Redis state backend is not supported in this distribution; choose local explicitly after reviewing its in-memory lifecycle");
  }
  if (config.type !== "local") {
    throw new Error("Unsupported state backend; supported public type: local");
  }

  const backend = new LocalStateBackend(config.local);
  await backend.initialize();
  return backend;
}
