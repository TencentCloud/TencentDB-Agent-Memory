/**
 * 写入层「被撤回的记忆不得通过合并复活」守卫（N06）。
 *
 * 为什么这条必须在**写入层**而不是各后端 store 里拦：
 * 三个后端的 upsert 语义不同 ——
 *   sqlite  ON CONFLICT DO UPDATE 的列清单不含 review_status ⇒ 天然保留；
 *   mongo   replaceOne 整文档替换       ⇒ 会抹掉状态（已改 $set/$setOnInsert）；
 *   tcvdb   upsert 整文档替换           ⇒ 会抹掉状态（无法只改一个字段）。
 * 与其在每个后端各打一个补丁、再祈祷第四个后端的作者记得，
 * 不如在唯一的写入入口直接不让这次写入发生。
 *
 * 失效后的表现：审核员撤回一条错误记忆 → 下次对话提到同一事实 →
 * 去重判定为"更新已有记忆" → 整文档覆盖 → 状态回到 active →
 * 被撤回的内容重新进入 prompt。接口全程 200，测试全绿。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorStore } from "../store/sqlite/memory-store.js";
import { __setMemoryReviewEnabledForTests } from "../store/visibility.js";
import { writeMemory, type DedupDecision, type ExtractedMemory } from "./l1-writer.js";

const memory = (content: string): ExtractedMemory => ({
  content, type: "work_fact", priority: 50,
  source_message_ids: [], metadata: {}, scene_name: "default",
});
const decision = (
  record_id: string,
  action: DedupDecision["action"],
  target_ids: string[] = [],
  merged_content?: string,
): DedupDecision => ({ record_id, action, target_ids, merged_content });

const ISO = { teamId: "t1", userId: "u1", agentId: "a1" } as const;
const WRITE_ISO = { ...ISO, sessionKey: "sk-x", sessionId: "ses-x" };

describe("被撤回的记忆不得通过合并复活", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    __setMemoryReviewEnabledForTests(true);
    dir = mkdtempSync(path.join(tmpdir(), "mem-guard-"));
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    __setMemoryReviewEnabledForTests(undefined);
    try { store.close?.(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("update 目标已被撤回 ⇒ 整次写入被丢弃，记忆保持隔离", async () => {
    await writeMemory({
      ...WRITE_ISO, baseDir: dir, vectorStore: store,
      memory: memory("用户的报销上限是 500 元"), decision: decision("m_a", "store"),
    });
    expect(store.queryL1Records({ ...ISO })).toHaveLength(1);

    store.setL1ReviewStatus("m_a", "quarantined", ISO);
    expect(store.queryL1Records({ ...ISO })).toHaveLength(0);

    // 下一轮对话提到同一事实，去重判定为"更新 m_a"
    const written = await writeMemory({
      ...WRITE_ISO, baseDir: dir, vectorStore: store,
      memory: memory("用户的报销上限是 500 元（再次确认）"),
      decision: decision("m_b", "update", ["m_a"], "用户的报销上限是 500 元"),
    });

    expect(written).toBeNull();                                     // 写入被丢弃
    expect(store.queryL1Records({ ...ISO })).toHaveLength(0);       // 读路径仍然空
    const all = store.queryL1Records({ ...ISO, visibility: "all" });
    expect(all).toHaveLength(1);                                    // 没有新增记录
    expect(all[0].record_id).toBe("m_a");
    expect((all[0] as unknown as { review_status?: string }).review_status).toBe("quarantined");
    expect(all[0].content).toBe("用户的报销上限是 500 元");          // 内容未被覆盖
  });

  it("merge 目标已被撤回 ⇒ 同样丢弃", async () => {
    await writeMemory({
      ...WRITE_ISO, baseDir: dir, vectorStore: store,
      memory: memory("事实 A"), decision: decision("m_x", "store"),
    });
    store.setL1ReviewStatus("m_x", "quarantined", ISO);

    const written = await writeMemory({
      ...WRITE_ISO, baseDir: dir, vectorStore: store,
      memory: memory("事实 A 的补充"),
      decision: decision("m_y", "merge", ["m_x"], "事实 A + 补充"),
    });
    expect(written).toBeNull();
    expect(store.queryL1Records({ ...ISO, visibility: "all" })).toHaveLength(1);
  });

  it("目标未被撤回 ⇒ 正常合并，守卫不得误伤", async () => {
    await writeMemory({
      ...WRITE_ISO, baseDir: dir, vectorStore: store,
      memory: memory("原始事实"), decision: decision("m_ok", "store"),
    });
    const written = await writeMemory({
      ...WRITE_ISO, baseDir: dir, vectorStore: store,
      memory: memory("更新后的事实"),
      decision: decision("m_ok2", "update", ["m_ok"], "更新后的事实"),
    });
    expect(written).not.toBeNull();
    const rows = store.queryL1Records({ ...ISO });
    expect(rows.map((r) => r.content)).toContain("更新后的事实");
  });

  it("多目标中只要有一个被撤回就整体丢弃（不做部分合并）", async () => {
    await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("甲"), decision: decision("m_1", "store") });
    await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("乙"), decision: decision("m_2", "store") });
    store.setL1ReviewStatus("m_2", "quarantined", ISO);

    const written = await writeMemory({
      ...WRITE_ISO, baseDir: dir, vectorStore: store,
      memory: memory("甲乙合并"),
      decision: decision("m_3", "merge", ["m_1", "m_2"], "甲乙合并"),
    });
    // 部分合并会产生一条"含有被撤回内容"的新记忆 —— 比不合并更糟
    expect(written).toBeNull();
    expect(store.queryL1Records({ ...ISO }).map((r) => r.record_id)).toEqual(["m_1"]);
  });

  it("does not write or delete when the review guard cannot read its targets", async () => {
    await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("existing"), decision: decision("m_guard", "store") });
    const read = vi.spyOn(store, "queryL1Records").mockImplementationOnce(() => { throw new Error("read unavailable"); });
    const deletion = vi.spyOn(store, "deleteL1Batch");
    const upsert = vi.spyOn(store, "upsertL1");
    const written = await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("replacement"), decision: decision("m_new", "update", ["m_guard"]) });
    expect(written).toBeNull();
    expect(read.mock.calls[0]?.[0]).toMatchObject({ recordIds: ["m_guard"], visibility: "all" });
    expect(deletion).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("a failed successor commit never destroys its predecessor or claims supersession", async () => {
    await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("prior"), decision: decision("prior", "store") });
    vi.spyOn(store, "upsertL1").mockReturnValueOnce(false);
    const deletion = vi.spyOn(store, "deleteL1Batch");
    const result = await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("next"), decision: decision("next", "update", ["prior"]) });
    expect(result).toBeNull();
    expect(deletion).not.toHaveBeenCalled();
    expect(store.queryL1Records(ISO).map((r) => r.record_id)).toEqual(["prior"]);
    expect(store.queryMemoryEvents({ record_id: "next" })).toEqual([]);
  });

  it("an extraction ledger failure rolls back every change made inside its transaction", async () => {
    await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("prior"), decision: decision("prior", "store") });
    const upsert = store.upsertL1.bind(store);
    vi.spyOn(store, "upsertL1").mockImplementationOnce((record, embedding) => {
      store.setL1ReviewStatus("prior", "quarantined", ISO);
      return upsert(record, embedding);
    });
    const append = store.appendMemoryEvent.bind(store);
    vi.spyOn(store, "appendMemoryEvent").mockImplementation((e) => {
      if (e.source === "extraction") throw new Error("ledger unavailable");
      return append(e);
    });
    await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("next"), decision: decision("next", "update", ["prior"]) });
    expect(store.queryL1Records(ISO).map((row) => row.record_id)).toEqual(["prior"]);
    expect(store.queryL1Records({ ...ISO, visibility: "all" })[0]?.review_sources_json).toBe("[]");
    expect(store.queryMemoryEvents({ source: "review" })).toEqual([]);
  });

  it("关闭审核写入口仍保留防复活守卫", async () => {
    await writeMemory({ ...WRITE_ISO, baseDir: dir, vectorStore: store, memory: memory("基线行为"), decision: decision("m_base", "store") });
    store.setL1ReviewStatus("m_base", "quarantined", ISO);

    __setMemoryReviewEnabledForTests(false);
    const written = await writeMemory({
      ...WRITE_ISO, baseDir: dir, vectorStore: store,
      memory: memory("基线行为更新"),
      decision: decision("m_base2", "update", ["m_base"], "基线行为更新"),
    });
    expect(written).toBeNull();  // 关闭审核写入口不取消已有抑制
  });
});
