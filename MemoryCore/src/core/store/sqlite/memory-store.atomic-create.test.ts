import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { VectorStore } from "./memory-store.js";

const stores: VectorStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createStore(): VectorStore {
  const dir = mkdtempSync(path.join(tmpdir(), "tdai-create-l1-"));
  tempDirs.push(dir);
  const store = new VectorStore(path.join(dir, "memory.db"), 0);
  stores.push(store);
  store.init();
  return store;
}

function record(content: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id: "approved-memory-1",
    content,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: { source: "lifeos", approval_ref: "approval-1" },
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    sessionKey: "session-1",
    sessionId: "session-1",
    teamId: "team-1",
    agentId: "agent-1",
    userId: "user-1",
  };
}

describe("SQLite createL1", () => {
  it("inserts once and leaves the winner unchanged on duplicate IDs", () => {
    const store = createStore();
    expect(store.isDegraded()).toBe(false);

    expect(store.createL1(record("original approved content"))).toBe(true);
    expect(store.createL1(record("conflicting payload"))).toBe(false);

    const rows = store.queryL1Records({ recordIds: ["approved-memory-1"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("original approved content");
    expect(JSON.parse(rows[0].metadata_json)).toEqual({ source: "lifeos", approval_ref: "approval-1" });
  });
});
