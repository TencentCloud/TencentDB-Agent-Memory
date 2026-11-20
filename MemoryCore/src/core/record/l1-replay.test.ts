import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorStore } from "../store/sqlite/memory-store.js";
import { planReplay, replayL1, type ReplaySelection, type ReplaySource } from "./l1-replay.js";

const scope = { instanceId: "default", teamId: "team-a", userId: "user-a", agentId: "agent-a",
  sessionKey: "shared-key", sessionId: "session-a", taskId: "task-a" };
const selection: ReplaySelection = { scope };
const time = "2026-10-01T10:00:00.000Z";
const candidates = (rows: ReplaySource[]) => rows.map((r) => ({
  content: `Remember ${r.record_id}`, type: "work_fact" as const, priority: 70,
  scene_name: "Project Atlas", source_message_ids: [r.record_id], metadata: {},
}));

describe("SQLite L1 replay recovery", () => {
  let dir: string;
  let store: VectorStore;
  const db = () => store.getRawDb();
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "l1-replay-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
    expect(store.isDegraded()).toBe(false);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  function add(id: string, overrides: Partial<typeof scope> = {}, recordedAt = time) {
    expect(store.upsertL0({ id, ...scope, ...overrides, role: "user",
      messageText: `Project Atlas milestone ${id} must be shipped before Friday.`,
      recordedAt, timestamp: Date.parse(recordedAt) }, undefined)).toBe(true);
  }
  function records() { return db().prepare("SELECT * FROM l1_records ORDER BY record_id").all(); }

  it("dry-run reads historical L0 without creating tables, writing data or calling a model", () => {
    add("m1"); add("m2");
    const schema = db().prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    const changes = db().prepare("SELECT total_changes() AS n").get();
    expect(planReplay(db(), selection)).toMatchObject({ selected: 2, alreadyComplete: 0,
      sourceIds: ["m1", "m2"] });
    expect(records()).toEqual([]);
    expect(db().prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(db().prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  });

  it("replays historical rows once, retaining L0 IDs and source lineage across restart", async () => {
    add("m1"); add("m2");
    const before = db().prepare("SELECT * FROM l0_conversations ORDER BY record_id").all();
    const extract = vi.fn(async (rows: ReplaySource[]) => candidates(rows));
    const first = await replayL1(store, selection, extract);
    expect(first.completed).toBe(2);
    expect(records()).toHaveLength(2);
    expect(records().map((r) => JSON.parse(String(r.metadata_json)).source_message_ids).sort())
      .toEqual([["m1"], ["m2"]]);
    const persisted = records();
    store.close(); store = new VectorStore(path.join(dir, "vectors.db"), 0); store.init();
    const second = await replayL1(store, selection, extract);
    expect(second.alreadyComplete).toBe(2);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(records()).toEqual(persisted);
    expect(db().prepare("SELECT * FROM l0_conversations ORDER BY record_id").all()).toEqual(before);
    expect(second.receipts).toEqual(first.receipts);
  });

  it("does not duplicate output for overlapping ranges or changed batch boundaries", async () => {
    for (let i = 0; i < 21; i++) add(`m${String(i).padStart(2, "0")}`, {}, new Date(Date.parse(time) + i).toISOString());
    const extract = vi.fn(async (rows: ReplaySource[]) => candidates(rows));
    await replayL1(store, { scope, to: new Date(Date.parse(time) + 12).toISOString() }, extract);
    await replayL1(store, { scope, from: new Date(Date.parse(time) + 5).toISOString() }, extract);
    expect(records()).toHaveLength(21);
    expect(new Set(records().map((r) => r.content)).size).toBe(21);
    expect(extract.mock.calls.flatMap(([rows]) => rows.map((r) => r.record_id))).toHaveLength(21);
  });

  it("handles more than a normal query window of equal timestamps without skipping siblings", async () => {
    for (let i = 0; i < 41; i++) add(`m${String(i).padStart(2, "0")}`);
    const extract = vi.fn(async (rows: ReplaySource[]) => candidates(rows));
    const result = await replayL1(store, selection, extract);
    expect(result.completed).toBe(41);
    expect(records()).toHaveLength(41);
    expect(extract.mock.calls.map(([rows]) => rows.length)).toEqual([10, 10, 10, 10, 1]);
  });

  it("retries an extraction failure without falsely completing its inputs", async () => {
    add("m1");
    const extract = vi.fn().mockRejectedValueOnce(new Error("provider unavailable"))
      .mockImplementation(async (rows: ReplaySource[]) => candidates(rows));
    await expect(replayL1(store, selection, extract)).rejects.toThrow();
    expect(records()).toEqual([]);
    expect(planReplay(db(), selection).alreadyComplete).toBe(0);
    await replayL1(store, selection, extract);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(records()).toHaveLength(1);
  });

  it("rolls back all L1 writes and resumes the persisted model result after a storage failure", async () => {
    add("m1"); add("m2");
    // Real SQLite failure after the first INSERT, not a mocked repository method.
    db().exec(`CREATE TRIGGER replay_disk_failure BEFORE INSERT ON l1_records
      WHEN NEW.content = 'Remember m2' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    const extract = vi.fn(async (rows: ReplaySource[]) => candidates(rows));
    await expect(replayL1(store, selection, extract)).rejects.toThrow();
    expect(records()).toEqual([]);
    expect(db().prepare("SELECT count(*) AS n FROM l1_fts").get()?.n).toBe(0);
    expect(planReplay(db(), selection).alreadyComplete).toBe(0);
    db().exec("DROP TRIGGER replay_disk_failure");
    store.close(); store = new VectorStore(path.join(dir, "vectors.db"), 0); store.init();
    await replayL1(store, selection, extract);
    expect(records()).toHaveLength(2);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("does not mark a batch complete when the FTS index write fails", async () => {
    add("m1");
    db().exec("ALTER TABLE l1_fts RENAME TO unavailable_l1_fts");
    const extract = vi.fn(async (rows: ReplaySource[]) => candidates(rows));
    await expect(replayL1(store, selection, extract)).rejects.toThrow();
    expect(records()).toEqual([]);
  });

  it("preserves already committed batches when a later batch fails", async () => {
    for (let i = 0; i < 12; i++) add(`m${String(i).padStart(2, "0")}`);
    const extract = vi.fn().mockImplementationOnce(async (rows: ReplaySource[]) => candidates(rows))
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockImplementation(async (rows: ReplaySource[]) => candidates(rows));
    await expect(replayL1(store, selection, extract)).rejects.toThrow();
    expect(records()).toHaveLength(10);
    expect(planReplay(db(), selection).alreadyComplete).toBe(10);
    const result = await replayL1(store, selection, extract);
    expect(result.completed).toBe(12);
    expect(records()).toHaveLength(12);
    expect(extract).toHaveBeenCalledTimes(3);
  });

  it("records successful empty extraction as completed without repeatedly calling the model", async () => {
    add("m1");
    const extract = vi.fn(async () => []);
    await replayL1(store, selection, extract);
    expect((await replayL1(store, selection, extract)).alreadyComplete).toBe(1);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(records()).toEqual([]);
  });

  it.each(["teamId", "userId", "agentId", "sessionKey", "sessionId", "taskId"] as const)
    ("never reads or writes another %s scope even when text and session names match", async (field) => {
      add("mine"); add("other", { [field]: "other" });
      const extract = vi.fn(async (rows: ReplaySource[]) => candidates(rows));
      await replayL1(store, selection, extract);
      expect(extract.mock.calls[0][0].map((r) => r.record_id)).toEqual(["mine"]);
      expect(records()).toHaveLength(1);
      expect(records()[0]).toMatchObject({ team_id: scope.teamId, user_id: scope.userId,
        agent_id: scope.agentId, session_id: scope.sessionId, task_id: scope.taskId });
      expect(planReplay(db(), { scope: { ...scope, [field]: "other" } }).alreadyComplete).toBe(0);
    });

  it("rejects fabricated source IDs from another tenant before any L1 write", async () => {
    add("mine"); add("other", { teamId: "other" });
    const extract = async () => [{ ...candidates([{ record_id: "mine" } as ReplaySource])[0], source_message_ids: ["other"] }];
    await expect(replayL1(store, selection, extract)).rejects.toThrow(/source/i);
    expect(records()).toEqual([]);
    expect(planReplay(db(), selection).alreadyComplete).toBe(0);
  });

  it.each(["changed", "deleted"])("rejects a %s source before committing the prepared batch", async (change) => {
    add("m1");
    const extract = async (rows: ReplaySource[]) => {
      db().exec(change === "changed"
        ? "UPDATE l0_conversations SET message_text = 'changed' WHERE record_id = 'm1'"
        : "DELETE FROM l0_conversations WHERE record_id = 'm1'");
      return candidates(rows);
    };
    await expect(replayL1(store, selection, extract)).rejects.toThrow(/changed|source/i);
    expect(records()).toEqual([]);
    expect(db().prepare("SELECT receipt_json FROM l1_replay_batches").get()?.receipt_json).toBeNull();
  });

  it("reports exact-content skips without modifying an existing memory", async () => {
    add("m1");
    await replayL1(store, selection, async (rows) => candidates(rows));
    const existing = records();
    add("m2");
    const result = await replayL1(store, selection, async (rows) => candidates(rows).map((r) => ({ ...r, content: "Remember m1" })));
    expect(records()).toEqual(existing);
    expect(result.receipts.flatMap((r) => r.decisions).map((d) => d.action)).toContain("skip_exact");
  });

  it.each(["teamId", "userId", "agentId", "sessionKey", "sessionId", "taskId"] as const)
    ("never deduplicates against another %s scope's identical content", async (field) => {
    add("m1");
    await replayL1(store, selection, async (rows) => candidates(rows));
    add("m2", { [field]: "other" });
    await replayL1(store, { scope: { ...scope, [field]: "other" } }, async (rows) => candidates(rows).map((r) => ({ ...r, content: "Remember m1" })));
    expect(records()).toHaveLength(2);
  });

  it("concurrent replay callers commit one winning preparation and one set of records", async () => {
    add("m1");
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const slow = replayL1(store, selection, async (rows) => { await gate; return candidates(rows); });
    const other = new VectorStore(path.join(dir, "vectors.db"), 0); other.init();
    try {
      await replayL1(other, selection, async (rows) => candidates(rows).map((r) => ({ ...r, content: "winning result" })));
      release(); await slow;
      expect(records()).toHaveLength(1);
      expect(records()[0].content).toBe("winning result");
    } finally { release(); await slow.catch(() => {}); other.close(); }
  });

  it("fails closed on missing scope, invalid dates and oversized ranges", () => {
    add("m1"); add("m2");
    expect(() => planReplay(db(), { scope: { ...scope, teamId: "" } })).toThrow();
    expect(() => planReplay(db(), { scope, from: "not-a-date" })).toThrow();
    expect(() => planReplay(db(), { scope, from: "2026-02-30T00:00:00Z" })).toThrow();
    expect(() => planReplay(db(), { scope, from: "2027-01-01T00:00:00Z", to: time })).toThrow();
    expect(() => planReplay(db(), { scope, maxRows: 1 })).toThrow(/range|limit/i);
  });

  it("requires the whole original batch when resuming a partially overlapping failed range", async () => {
    add("m1"); add("m2", {}, new Date(Date.parse(time) + 1000).toISOString());
    await expect(replayL1(store, selection, async () => { throw new Error("offline"); })).rejects.toThrow();
    const extract = vi.fn(async (rows: ReplaySource[]) => candidates(rows));
    await expect(replayL1(store, { scope, to: time }, extract)).rejects.toThrow(/original range/);
    expect(extract).not.toHaveBeenCalled();
    expect((await replayL1(store, selection, extract)).completed).toBe(2);
  });

  it("compares inclusive date bounds as instants and does not capture messages arriving during extraction", async () => {
    add("m1"); add("earlier", {}, new Date(Date.parse(time) - 1).toISOString());
    const range = { scope, from: "2026-10-01T18:00:00+08:00", to: time };
    expect(planReplay(db(), range).sourceIds).toEqual(["m1"]);
    const extract = vi.fn(async (rows: ReplaySource[]) => { add("new"); return candidates(rows); });
    await replayL1(store, range, extract);
    expect(records().map((r) => r.content)).toEqual(["Remember m1"]);
    expect(planReplay(db(), range)).toMatchObject({ selected: 2, alreadyComplete: 1, pending: 1 });
  });

  it("keeps ordinary upsert atomic outside a replay transaction", () => {
    const record = { id: "ordinary", ...scope, content: "original", type: "work_fact" as const, priority: 70,
      scene_name: "Atlas", source_message_ids: [], metadata: {}, timestamps: [time], createdAt: time, updatedAt: time };
    expect(store.upsertL1(record, undefined)).toBe(true);
    const before = records();
    db().exec("CREATE TRIGGER prevent_update BEFORE UPDATE ON l1_records BEGIN SELECT RAISE(ABORT, 'failed'); END");
    expect(store.upsertL1({ ...record, content: "replacement" }, undefined)).toBe(false);
    expect(records()).toEqual(before);
    expect(db().prepare("SELECT content_original FROM l1_fts WHERE record_id = 'ordinary'").get()?.content_original).toBe("original");
    db().exec("DROP TRIGGER prevent_update");
    expect(store.upsertL1({ ...record, content: "replacement" }, undefined)).toBe(true);
  });

  it("rolls back journal initialization if its second table cannot be created", async () => {
    add("m1");
    db().exec("CREATE INDEX l1_replay_sources ON l0_conversations(record_id)");
    const extract = vi.fn(async (rows: ReplaySource[]) => candidates(rows));
    await expect(replayL1(store, selection, extract)).rejects.toThrow();
    expect(extract).not.toHaveBeenCalled();
    expect(db().prepare("SELECT name FROM sqlite_master WHERE name = 'l1_replay_batches'").get()).toBeUndefined();
    db().exec("DROP INDEX l1_replay_sources");
    expect((await replayL1(store, selection, extract)).completed).toBe(1);
  });
});
