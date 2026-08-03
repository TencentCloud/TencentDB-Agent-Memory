/**
 * Typed errors for ApplyExecutor (wave tdai-memory-subagents-2026-08-02, P4).
 *
 * Each carries an HTTP statusCode so the route handler in apply-route.ts can
 * map aborts without inspecting the class hierarchy. All extend Error so
 * they pass `instanceof Error` checks at the route boundary.
 */

/** Invalid diff / guardrail violation — aborted before any mutation. */
export class ApplyValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ApplyValidationError";
  }
}

/** Trust-boundary manifest drift — files changed outside /memory/apply. */
export class ManifestDriftError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ManifestDriftError";
  }
}

/** A delete target was updated since the diff was built — fresh data at risk. */
export class StaleDeleteError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "StaleDeleteError";
  }
}

/** Store/fs runtime failure (deleteL1Batch=false, writeMemory null/throw, …). */
export class ApplyRuntimeError extends Error {
  readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = "ApplyRuntimeError";
  }
}
