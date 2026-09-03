import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../record/l1-writer.js";
import { VectorStore } from "./sqlite.js";

const opened: VectorStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    content: "original",
    type: "persona",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 2,
    sessionKey: "session-key",
    sessionId: "session-id",
    teamId: "team-1",
    userId: "user-1",
    agentId: "agent-1",
    ...overrides,
  };
}

function makeStore(): VectorStore {
  const dir = mkdtempSync(path.join(tmpdir(), "tdai-cas-"));
  dirs.push(dir);
  const store = new VectorStore(path.join(dir, "memory.sqlite"), 0);
  const init = store.init();
  expect(store.isDegraded(), init.reason).toBe(false);
  opened.push(store);
  return store;
}

describe("VectorStore.compareAndSwapL1", () => {
  it("updates exactly once and rejects a stale writer without overwriting content", async () => {
    const store = makeStore();
    expect(await store.upsertL1(makeRecord(), undefined)).toBe(true);

    const first = await store.compareAndSwapL1(
      makeRecord({ content: "first edit", version: 3 }),
      2,
      undefined,
    );
    expect(first).toEqual({ status: "updated" });

    const stale = await store.compareAndSwapL1(
      makeRecord({ content: "stale edit", version: 3 }),
      2,
      undefined,
    );
    expect(stale).toEqual({ status: "conflict", currentVersion: 3 });

    const [persisted] = await store.queryL1Records({ recordIds: ["memory-1"] });
    expect(persisted.content).toBe("first edit");
    expect(persisted.version).toBe(3);
  });

  it("distinguishes a deleted record from a version conflict", async () => {
    const store = makeStore();
    const result = await store.compareAndSwapL1(makeRecord({ id: "missing" }), 2, undefined);
    expect(result).toEqual({ status: "not_found" });
  });
});
