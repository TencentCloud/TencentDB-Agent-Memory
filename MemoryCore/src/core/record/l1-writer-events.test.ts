/**
 * writeMemory 的 memory_events 埋点测试。
 *
 * 覆盖四种 dedup action 的事件语义：
 *  - store   → 1 × created
 *  - update  → N × superseded（旧内容快照 + origin session）+ 1 × updated
 *  - merge   → N × superseded + 1 × merged
 *  - skip    → 无事件
 * 以及：target 查询失败时 superseded 降级缺失但 updated 事件仍写。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorStore } from "../store/sqlite/memory-store.js";
import { writeMemory, type ExtractedMemory, type DedupDecision } from "./l1-writer.js";

const memory = (content: string): ExtractedMemory => ({
  content,
  type: "work_fact",
  priority: 50,
  source_message_ids: ["msg-1"],
  metadata: {},
  scene_name: "default",
});

const decision = (record_id: string, action: DedupDecision["action"], target_ids: string[] = [], merged_content?: string): DedupDecision => ({
  record_id,
  action,
  target_ids,
  merged_content,
});

describe("writeMemory memory events", () => {
  let dir: string;
  let store: VectorStore;
  const iso = () => ({
    sessionKey: "sk-x",
    sessionId: "ses-x",
    teamId: "t1",
    userId: "u1",
    agentId: "a1",
    baseDir: dir,
    vectorStore: store,
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "l1-events-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("store action appends one created event", async () => {
    await writeMemory({ ...iso(), memory: memory("salary is 5000"), decision: decision("m_a", "store") });
    const events = store.queryMemoryEvents({ session_id: "ses-x" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "created", record_id: "m_a", content: "salary is 5000", session_id: "ses-x" });
  });

  it("skip action appends nothing", async () => {
    const ret = await writeMemory({ ...iso(), memory: memory("dup"), decision: decision("m_dup", "skip") });
    expect(ret).toBeNull();
    expect(store.queryMemoryEvents({ session_id: "ses-x" })).toHaveLength(0);
  });

  it("update action appends superseded snapshot + updated with supersedes", async () => {
    await writeMemory({ ...iso(), memory: memory("salary is 5000"), decision: decision("m_a", "store") });
    await writeMemory({
      ...iso(),
      sessionId: "ses-y",
      memory: memory("salary is 6000"),
      decision: decision("m_b", "update", ["m_a"], "salary is 6000"),
    });

    const events = store.queryMemoryEvents({ session_id: "ses-y" });
    expect(events.map((e) => e.op)).toEqual(["superseded", "updated"]);

    // superseded: old content snapshot, acting session + origin session
    expect(events[0]).toMatchObject({
      record_id: "m_a",
      content: "salary is 5000",
      session_id: "ses-y",
      origin_session_id: "ses-x",
      superseded_by: "m_b",
    });
    expect(events[1]).toMatchObject({ record_id: "m_b", content: "salary is 6000" });
    expect(events[1].supersedes).toEqual(["m_a"]);
  });

  it("merge action appends one superseded per target + one merged", async () => {
    await writeMemory({ ...iso(), memory: memory("c1"), decision: decision("m_c1", "store") });
    await writeMemory({ ...iso(), memory: memory("c2"), decision: decision("m_c2", "store") });
    await writeMemory({ ...iso(), memory: memory("merged"), decision: decision("m_cm", "merge", ["m_c1", "m_c2"], "merged") });

    const events = store.queryMemoryEvents({ session_id: "ses-x" });
    expect(events.map((e) => e.op)).toEqual(["created", "created", "superseded", "superseded", "merged"]);
    const superseded = events.filter((e) => e.op === "superseded");
    expect(superseded.map((e) => e.record_id).sort()).toEqual(["m_c1", "m_c2"]);
    expect(superseded.every((e) => e.superseded_by === "m_cm")).toBe(true);
  });

  it("update on missing target still writes the updated event without superseded", async () => {
    await writeMemory({ ...iso(), memory: memory("x"), decision: decision("m_o", "update", ["m_gone"], "x") });
    const events = store.queryMemoryEvents({ session_id: "ses-x" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: "updated", record_id: "m_o" });
  });
});
