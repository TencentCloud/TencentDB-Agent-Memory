import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "./memory-store.js";

const BASE_L1_DDL = `CREATE TABLE l1_records (
  record_id TEXT PRIMARY KEY, content TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'episodic',
  priority INTEGER NOT NULL DEFAULT 50, scene_name TEXT NOT NULL DEFAULT '',
  session_key TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '', team_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 0,
  timestamp_str TEXT NOT NULL DEFAULT '', timestamp_start TEXT NOT NULL DEFAULT '', timestamp_end TEXT NOT NULL DEFAULT '',
  created_time TEXT NOT NULL DEFAULT '', updated_time TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}',
  user_id TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '')`;

describe("target-branch content upgrade creates the final ledger directly", () => {
  let dir: string;
  let dbPath: string;
  let store: VectorStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ledger-install-"));
    dbPath = path.join(dir, "vectors.db");
    const db = new DatabaseSync(dbPath);
    db.exec(BASE_L1_DDL);
    db.exec(`INSERT INTO l1_records (record_id, content, team_id, user_id, agent_id, session_key, session_id)
      VALUES ('existing', 'target-branch fact', 't1', 'u1', 'a1', 'sk', 'ses')`);
    db.close();
    store = new VectorStore(dbPath, 0);
    store.init();
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps existing content active and supports current review without a historical ledger", () => {
    const scope = { teamId: "t1", userId: "u1", agentId: "a1" };
    expect(store.isDegraded()).toBe(false);
    expect(store.queryMemoryEvents({})).toEqual([]);
    expect(store.queryL1Records(scope)[0]?.content).toBe("target-branch fact");
    store.setL1ReviewStatus("existing", "quarantined", scope);
    expect(store.queryL1Records(scope)).toEqual([]);
    const event = store.queryMemoryEvents({})[0]!;
    expect(event.review?.protocol).toBe(2);
    expect(event.event_id).toMatch(/^evt-[a-f0-9]{32}$/);
    store.appendMemoryEvent(event);
    expect(store.queryMemoryEvents({})).toHaveLength(1);
    store.setL1ReviewStatus("existing", "active", scope);
    expect(store.queryL1Records(scope)[0]?.content).toBe("target-branch fact");
  });

  it("reopening preserves receipt identities and final indexes without rebuilding the ledger", () => {
    store.setL1ReviewStatus("existing", "quarantined", { teamId: "t1", userId: "u1", agentId: "a1" });
    const before = store.queryMemoryEvents({});
    store.close();
    store = new VectorStore(dbPath, 0);
    store.init();
    expect(store.queryMemoryEvents({})).toEqual(before);
    const db = store.getRawDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='memory_events_oprebuild'").get()).toBeUndefined();
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_events'").all();
    expect(indexes).toContainEqual({ name: "idx_memory_events_event_id" });
    expect(indexes).toContainEqual({ name: "idx_memory_events_review_operation" });
    expect(indexes).toContainEqual({ name: "idx_memory_events_clear_epoch" });
  });
});
