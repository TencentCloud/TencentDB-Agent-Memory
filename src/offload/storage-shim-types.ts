/**
 * Shared types for storage sub-modules. Tiny module to break circular
 * dependencies between storage/*.ts files (each sub-module imports the
 * StorageContext interface from here instead of from a sibling).
 */
import type { OffloadEntry } from "./types.js";

/** Immutable per-session storage path context. Created once per session switch. */
export interface StorageContext {
  readonly dataRoot: string;
  readonly dataDir: string;
  readonly refsDir: string;
  readonly mmdsDir: string;
  readonly offloadJsonl: string;
  readonly stateFile: string;
  readonly agentName: string;
  readonly sessionId: string;
}

/** Re-export of OffloadEntry for downstream consumers. */
export type { OffloadEntry };
