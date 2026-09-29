/** Helpers for reporting the actual availability of the memory store. */
export type StoreHealthStatus = "ok" | "degraded" | "unavailable";

export interface HealthCheckedStore {
  isDegraded(): boolean;
  getDegradedReason?(): string | undefined;
}

export interface StoreHealth {
  status: StoreHealthStatus;
  reason?: string;
}

/**
 * A constructed store can still be unusable: SQLite deliberately keeps such a
 * store alive in degraded no-op mode. Health must distinguish that from a
 * usable store so readiness probes do not accept a write-dropping instance.
 */
export function getStoreHealth(store: HealthCheckedStore | undefined): StoreHealth {
  if (!store) return { status: "unavailable" };
  if (!store.isDegraded()) return { status: "ok" };

  const reason = store.getDegradedReason?.();
  return reason ? { status: "degraded", reason } : { status: "degraded" };
}
