import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { TdaiCore } from "../src/core/tdai-core.js";
import { StorageAdapter } from "../src/core/storage/adapter.js";
import { LocalStorageBackend } from "../src/core/storage/local-backend.js";
import type { ResolvedSkillConfig } from "../src/core/skill/types.js";
const marker = "synthetic-private-backend-error";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function method(name: string): (...args: unknown[]) => Promise<void> {
  const fn: unknown = Object.getOwnPropertyDescriptor(TdaiCore.prototype, name)?.value;
  if (typeof fn !== "function") throw new Error("Missing skill wiring method"); return fn;
}
function receiver(storage: StorageAdapter | { type: "local" | "cos" } = { type: "local" }) {
  return { cfg: { skill: { enabled: true }, embedding: { enabled: false }, storeBackend: "sqlite" },
    storage, vectorStore: { getRawDb: vi.fn((): DatabaseSync => { throw new Error(marker); }), getEmbeddingDimensions: () => 0 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    storeReady: undefined as Promise<void> | undefined,
    resolvedSkillConfig: undefined as ResolvedSkillConfig | undefined,
    skillCore: undefined as unknown, skillExtractor: undefined as unknown,
    doWireSkillModule: method("doWireSkillModule") };
}
it("stops before accessing SQLite when skill is disabled during store readiness", async () => {
  const r = receiver(); let release!: () => void;
  r.storeReady = new Promise<void>(resolve => { release = resolve; });
  const wiring = method("ensureSkillModuleWired").call(r);
  r.cfg.skill.enabled = false; release(); await wiring;
  expect(r.vectorStore.getRawDb).not.toHaveBeenCalled(); expect(r.resolvedSkillConfig).toBeUndefined();
});
it("uses the injected COS backend capability instead of absent legacy config credentials", async () => {
  const r = receiver({ type: "cos" }); await method("doWireSkillModule").call(r);
  expect(r.resolvedSkillConfig?.contentBackend).toBe("cos");
});
it("does not access obsolete COS configuration when local storage is selected", async () => {
  const r = receiver(); const access = vi.fn(() => { throw new Error(marker); });
  Object.defineProperty(r.cfg, "cos", { get: access }); await method("doWireSkillModule").call(r);
  expect(access).not.toHaveBeenCalled(); expect(r.resolvedSkillConfig?.contentBackend).toBe("local");
});
it("contains wiring failure without copying raw backend errors into diagnostics", async () => {
  const r = receiver(); await method("doWireSkillModule").call(r);
  expect(r.vectorStore.getRawDb).toHaveBeenCalledOnce(); expect(r.skillCore).toBeUndefined(); expect(r.skillExtractor).toBeUndefined();
  expect(JSON.stringify(Object.values(r.logger).map(fn => fn.mock.calls))).not.toContain(marker);
});
it("still wires a real in-memory SQLite skill store with local storage and no LLM", async () => {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const r = receiver(new StorageAdapter(new LocalStorageBackend("/tmp/synthetic-unused-skill-root")));
  r.vectorStore.getRawDb = vi.fn(() => db);
  await method("doWireSkillModule").call(r);
  expect(r.skillCore).toBeDefined(); expect(r.resolvedSkillConfig?.contentBackend).toBe("local");
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='skills'").get()).toBeDefined();
});
