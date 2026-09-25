import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VectorStore } from "../store/sqlite/memory-store.js";
import { queryMemoryRecords } from "./l1-reader.js";
import { recallL1Candidates } from "../tools/l1-candidate-recall.js";
import { batchDedup } from "./l1-dedup.js";
import { writeMemory, type MemoryRecord } from "./l1-writer.js";

const filter = { teamId: "team", userId: "user", agentId: "agent", sessionId: "session", sessionKey: "session" };
const oldDate = "2026-01-01T00:00:00.000Z";
const newDate = "2026-02-01T00:00:00.000Z";
const old: MemoryRecord = { id: "old", content: "Uses Polly", type: "persona", priority: 50,
  scene_name: "voice", source_message_ids: ["before"], metadata: {}, timestamps: [oldDate],
  createdAt: oldDate, updatedAt: oldDate, version: 0, ...filter };
const fresh = { record_id: "new", content: "Runs an offline voice engine", type: "persona" as const,
  priority: 50, scene_name: "voice", source_message_ids: ["after"], metadata: {} };
const update = { record_id: "new", action: "update", target_ids: ["old"], merged_content: "As of 2026-02-01, uses an offline voice engine instead of Polly" };
let directory: string;
let store: VectorStore;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "l1-maintenance-"));
  store = new VectorStore(path.join(directory, "db"), 0);
  store.init();
  store.upsertL1(old, undefined);
  for (const [id, date, text] of [["before", oldDate, "I use Polly"], ["after", newDate, "I switched to an offline voice engine"]]) {
    store.upsertL0({ id, ...filter, role: "user", messageText: text, timestamp: Date.parse(date), recordedAt: date }, undefined);
  }
});
afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });

function runner(decisions: unknown = [update], queries: unknown = ["Polly"]) {
  return { run: vi.fn(async (params: { taskId?: string; prompt?: string }) => JSON.stringify(params.taskId === "l1-maintenance-recall" ? queries : decisions)) };
}
async function dedup(llmRunner = runner(), memories = [fresh]) {
  return batchDedup({ memories, config: {}, vectorStore: store, filter, llmRunner });
}

it("finds an old fact via a planned topic, reviews both sources and preserves its correction chain", async () => {
  const llm = runner();
  const lookup = vi.spyOn(store, "queryL0ByIds");
  expect((await queryMemoryRecords(store, { recordIds: ["old"] }))[0].source_message_ids).toEqual(["before"]);
  expect((await recallL1Candidates({ query: "Polly", topK: 1, vectorStore: store })).hits[0].source_message_ids_json).toBe('["before"]');
  const decisions = await dedup(llm);
  expect(llm.run).toHaveBeenCalledTimes(2);
  const prompt = llm.run.mock.calls[1][0].prompt;
  expect(prompt).toContain("I use Polly");
  expect(prompt).toContain("I switched to an offline voice engine");
  expect(lookup).toHaveBeenCalledWith(["after", "before"], filter);
  expect(decisions[0]).toMatchObject({ action: "update", merged_timestamps: [oldDate, newDate] });
  const remove = vi.spyOn(store, "deleteL1Batch");
  const result = await writeMemory({ memory: fresh, decision: decisions[0], baseDir: directory, vectorStore: store, ...filter });
  expect(result).toMatchObject({ id: "old", version: 1, createdAt: oldDate,
    source_message_ids: ["before", "after"], metadata: { as_of: newDate,
      maintenance_history: [expect.objectContaining({ record_id: "old", content: "Uses Polly" })] } });
  expect(remove).not.toHaveBeenCalled();
  expect(store.queryL1Records()[0].content).toBe(update.merged_content);
  expect(store.queryL0ByIds(["before", "after"], filter)).toHaveLength(2);
  const merged = await writeMemory({ memory: fresh, decision: { ...decisions[0], action: "merge", record_id: "merged" },
    baseDir: directory, vectorStore: store, ...filter });
  expect(store.queryL1Records().map((r) => r.record_id)).toEqual(["merged"]);
  expect(merged?.metadata.maintenance_history?.map((r) => [r.record_id, r.version])).toEqual([["old", 0], ["old", 1]]);
  expect(merged?.metadata.maintenance_history?.every((r) => !r.metadata_json.includes("maintenance_history"))).toBe(true);
});

it.each(["unseen target", "missing evidence", "older evidence", "lookup failure"])("keeps the old record with %s", async (reason) => {
  let decision = update;
  if (reason === "unseen target") decision = { ...update, target_ids: ["unseen"] };
  if (reason === "missing evidence") store.deleteL0("before", filter);
  if (reason === "older evidence") store.upsertL0({ id: "after", ...filter, role: "user", messageText: "outdated", recordedAt: oldDate, timestamp: 1 }, undefined);
  if (reason === "lookup failure") vi.spyOn(store, "queryL0ByIds").mockImplementation(() => { throw new Error("unavailable"); });
  expect(await dedup(runner([decision]))).toEqual([{ record_id: "new", action: "store", target_ids: [] }]);
  expect(store.queryL1Records()[0].content).toBe(old.content);
});

it.each(["planning", "embedding"])("falls back to FTS when %s fails", async (failure) => {
  const llm = runner();
  if (failure === "planning") llm.run.mockRejectedValueOnce(new Error("timeout"));
  if (failure === "embedding") vi.spyOn(store, "getCapabilities").mockReturnValue({ ...store.getCapabilities(), vectorSearch: true });
  const embedBatch = vi.fn().mockRejectedValue(new Error("offline"));
  const decisions = await batchDedup({ memories: [{ ...fresh, content: "Stopped using Polly" }],
    config: {}, vectorStore: store, filter, llmRunner: llm,
    embeddingService: failure === "embedding" ? { embedBatch } as never : undefined });
  expect(decisions[0].action).toBe("update");
  if (failure === "embedding") expect(embedBatch).toHaveBeenCalledWith(["Polly", "Stopped using Polly"], undefined);
});

it("rejects duplicate target mutations and fabricated decision IDs", async () => {
  const decisions = await dedup(runner([update, { ...update, record_id: "second" }, { ...update, record_id: "fabricated" }]),
    [fresh, { ...fresh, record_id: "second" }]);
  expect(decisions.map((d) => [d.record_id, d.action])).toEqual([["new", "update"], ["second", "store"]]);
});

it("excludes out-of-scope sources even when referenced by an L1 record", async () => {
  store.upsertL0({ id: "foreign", ...filter, teamId: "other", role: "user", messageText: "secret", timestamp: 1, recordedAt: oldDate }, undefined);
  store.upsertL1({ ...old, source_message_ids: ["foreign", "before"] }, undefined);
  expect(store.queryL0ByIds([], filter)).toEqual([]);
  expect(store.queryL0ByIds(["foreign", "before"], filter).map((r) => r.record_id)).toEqual(["before"]);
  const llm = runner();
  await dedup(llm);
  expect(JSON.stringify(llm.run.mock.calls)).not.toContain("secret");
});

it.each([false, "throws"])("keeps merge targets if replacement persistence fails (%s)", async (failure) => {
  const remove = vi.spyOn(store, "deleteL1Batch");
  vi.spyOn(store, "upsertL1").mockImplementation(() => { if (failure) throw new Error("offline"); return false; });
  await writeMemory({ memory: fresh, decision: { ...update, action: "merge" }, baseDir: directory, vectorStore: store, ...filter });
  expect(remove).not.toHaveBeenCalled();
  expect(store.queryL1Records()[0].content).toBe(old.content);
});

it("keeps an update unchanged if the history append fails", async () => {
  const [decision] = await dedup();
  const upsert = vi.spyOn(store, "upsertL1");
  const result = await writeMemory({ memory: fresh, decision, baseDir: directory, vectorStore: store, ...filter,
    storage: { appendFile: async () => { throw new Error("storage offline"); } } as never });
  expect(result).toBeNull();
  expect(upsert).not.toHaveBeenCalled();
});

it("queries remote sources by primary key with the full isolation filter", async () => {
  const { TcvdbMemoryStore } = await import("../store/tcvdb/memory-store.js");
  const { MongoMemoryStore } = await import("../store/mongodb/memory-store.js");
  const query = vi.fn(async () => ({ documents: [] }));
  const tcvdb = { _ensureInit: async () => {}, degraded: false, client: { query }, l0Collection: "l0" } as unknown as InstanceType<typeof TcvdbMemoryStore>;
  await TcvdbMemoryStore.prototype.queryL0ByIds.call(tcvdb, ["before"], filter);
  expect(query).toHaveBeenCalledWith("l0", expect.objectContaining({ documentIds: ["before"],
    filter: 'team_id = "team" and user_id = "user" and agent_id = "agent" and session_id = "session" and session_key = "session"' }));
  const find = vi.fn(() => ({ toArray: async () => [] }));
  const mongo = { coll: async () => ({ find }) } as unknown as InstanceType<typeof MongoMemoryStore>;
  await MongoMemoryStore.prototype.queryL0ByIds.call(mongo, ["before"], filter);
  expect(find).toHaveBeenCalledWith({ _id: { $in: ["before"] }, team_id: "team", user_id: "user", agent_id: "agent", session_id: "session", session_key: "session" });
  query.mockClear(); find.mockClear();
  await TcvdbMemoryStore.prototype.queryL0ByIds.call(tcvdb, [], filter);
  await MongoMemoryStore.prototype.queryL0ByIds.call(mongo, [], filter);
  expect(query).not.toHaveBeenCalled(); expect(find).not.toHaveBeenCalled();
});

it("migrates a legacy SQLite database without provenance", async () => {
  store.close();
  const databasePath = path.join(directory, "db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec("ALTER TABLE l1_records DROP COLUMN source_message_ids_json");
  legacy.close();
  store = new VectorStore(databasePath, 0);
  store.init();
  expect((await queryMemoryRecords(store, { recordIds: ["old"] }))[0].source_message_ids).toEqual([]);
});

it.each(["teamId", "userId", "agentId", "sessionId", "sessionKey"] as const)("keeps merge provenance within %s", async (dimension) => {
  store.upsertL1({ ...old, id: "outside", source_message_ids: ["foreign"], [dimension]: "other" }, undefined);
  store.upsertL1({ ...old, id: "unrelated", source_message_ids: ["unrelated"] }, undefined);
  const written = await writeMemory({ memory: fresh, baseDir: directory, vectorStore: store, ...filter,
    decision: { ...update, action: "merge", target_ids: ["old", "outside"] } });
  expect(written?.source_message_ids).toEqual(["before", "after"]);
  expect(store.queryL1Records({ recordIds: ["outside", "unrelated"] })).toHaveLength(2);
  expect((await queryMemoryRecords(store, { recordIds: ["new"] }))[0].source_message_ids).toEqual(["before", "after"]);
});
