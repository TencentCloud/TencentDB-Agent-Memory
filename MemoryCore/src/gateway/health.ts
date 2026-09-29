/**
 * Health-status resolution for GET /health (#1432).
 *
 * A store object existing is not the same as the store working: the sqlite
 * store enters degraded mode (every operation silently no-ops) when the
 * sqlite-vec extension fails to load or schema initialization fails. The
 * health endpoint must surface that state instead of reporting "ok" whenever
 * a store instance is present.
 */
import type { IMemoryStore } from "../core/store/types.js";

export function resolveHealthStatus(
  vectorStore: Pick<IMemoryStore, "isDegraded"> | undefined,
): "ok" | "degraded" {
  if (!vectorStore) return "degraded";
  return vectorStore.isDegraded() ? "degraded" : "ok";
}
