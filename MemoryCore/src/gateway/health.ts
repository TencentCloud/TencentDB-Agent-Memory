import type { IMemoryStore } from "../core/store/types.js";

export type MemoryStoreHealth = "ok" | "degraded" | "missing";

export function memoryStoreHealth(
  store?: Pick<IMemoryStore, "isDegraded">,
): MemoryStoreHealth {
  if (!store) return "missing";
  return store.isDegraded() ? "degraded" : "ok";
}

export function overallHealthStatus(
  store?: Pick<IMemoryStore, "isDegraded">,
): "ok" | "degraded" {
  return memoryStoreHealth(store) === "ok" ? "ok" : "degraded";
}
