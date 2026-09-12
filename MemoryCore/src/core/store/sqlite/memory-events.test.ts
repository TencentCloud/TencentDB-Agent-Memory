/**
 * memory_events 表（session 变更集）存储层测试。
 *
 * 覆盖：
 *  - appendMemoryEvent / queryMemoryEvents round-trip
 *  - session_id / op / origin_session_id / 时间窗 / 租户维度过滤
 *  - seq 追加顺序、limit/offset 分页
 *  - 追加-only 语义：同 record_id 可多次出现（superseded + created 历史共存）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryEvent } from "../types.js";
import { VectorStore } from "./memory-store.js";

function makeEvent(over: Partial<MemoryEvent>): MemoryEvent {
  return {
    event_ts: "2026-01-01T00:00:00.000Z",
    session_key: "sk-a",
    session_id: "ses-a",
    team_id: "t1",
    user_id: "u1",
    agent_id: "a1",
    op: "created",
    record_id: "m_1",
    content: "content",
    ...over,
  };
}

describe("memory_events", () => {
  let dir: string;
  let store: VectorStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mem-events-"));
    // dimensions=0 → metadata/FTS-only mode, no sqlite-vec extension needed.
    store = new VectorStore(path.join(dir, "vectors.db"), 0);
    store.init();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends a created event and reads it back", () => {
    store.appendMemoryEvent(makeEvent({}));
    const rows = store.queryMemoryEvents({ session_id: "ses-a" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "created",
      record_id: "m_1",
      content: "content",
      session_id: "ses-a",
      session_key: "sk-a",
      team_id: "t1",
      user_id: "u1",
      agent_id: "a1",
    });
  });

  it("persists superseded snapshots with origin session metadata", () => {
    // ses-a writes a record, then ses-b supersedes it.
    store.appendMemoryEvent(makeEvent({ record_id: "m_old", content: "salary 5000" }));
    store.appendMemoryEvent(
      makeEvent({
        session_id: "ses-b",
        session_key: "sk-b",
        op: "superseded",
        record_id: "m_old",
        content: "salary 5000",
        version: 1,
        origin_session_id: "ses-a",
        origin_session_key: "sk-a",
        superseded_by: "m_new",
      }),
    );
    store.appendMemoryEvent(
      makeEvent({
        session_id: "ses-b",
        session_key: "sk-b",
        op: "updated",
        record_id: "m_new",
        content: "salary 6000",
        version: 2,
        supersedes: ["m_old"],
      }),
    );

    // Forward view: what did ses-b change?
    const sesB = store.queryMemoryEvents({ session_id: "ses-b" });
    expect(sesB.map((r) => r.op)).toEqual(["superseded", "updated"]);
    expect(sesB[0].superseded_by).toBe("m_new");
    expect(sesB[0].origin_session_id).toBe("ses-a");
    expect(sesB[0].origin_session_key).toBe("sk-a");
    expect(sesB[1].supersedes).toEqual(["m_old"]);

    // Reverse view: which of ses-a's records got replaced?
    const supersededFromSesA = store.queryMemoryEvents({ origin_session_id: "ses-a" });
    expect(supersededFromSesA).toHaveLength(1);
    expect(supersededFromSesA[0].session_id).toBe("ses-b");
  });

  it("filters by op", () => {
    store.appendMemoryEvent(makeEvent({ record_id: "m_1" }));
    store.appendMemoryEvent(makeEvent({ op: "superseded", record_id: "m_1", superseded_by: "m_2" }));
    store.appendMemoryEvent(makeEvent({ op: "updated", record_id: "m_2", supersedes: ["m_1"] }));

    const created = store.queryMemoryEvents({ session_id: "ses-a", op: "created" });
    expect(created).toHaveLength(1);
    expect(created[0].record_id).toBe("m_1");

    const superseded = store.queryMemoryEvents({ session_id: "ses-a", op: "superseded" });
    expect(superseded).toHaveLength(1);
  });

  it("filters by time window (ISO 8601 string order)", () => {
    store.appendMemoryEvent(makeEvent({ record_id: "m_1", event_ts: "2026-01-01T10:00:00.000Z" }));
    store.appendMemoryEvent(makeEvent({ record_id: "m_2", event_ts: "2026-01-02T10:00:00.000Z" }));
    store.appendMemoryEvent(makeEvent({ record_id: "m_3", event_ts: "2026-01-03T10:00:00.000Z" }));

    const rows = store.queryMemoryEvents({
      session_id: "ses-a",
      since: "2026-01-02T00:00:00.000Z",
      until: "2026-01-02T23:59:59.999Z",
    });
    expect(rows.map((r) => r.record_id)).toEqual(["m_2"]);
  });

  it("filters by tenancy isolation dimensions", () => {
    store.appendMemoryEvent(makeEvent({ record_id: "m_mine" }));
    store.appendMemoryEvent(
      makeEvent({ record_id: "m_other", team_id: "t2", user_id: "u2", agent_id: "a2" }),
    );

    const mine = store.queryMemoryEvents({ session_id: "ses-a", team_id: "t1", user_id: "u1", agent_id: "a1" });
    expect(mine.map((r) => r.record_id)).toEqual(["m_mine"]);
  });

  it("preserves insertion order and paginates", () => {
    for (let i = 0; i < 5; i++) {
      store.appendMemoryEvent(makeEvent({ record_id: `m_${i}` }));
    }
    const page1 = store.queryMemoryEvents({ session_id: "ses-a", limit: 2, offset: 0 });
    const page2 = store.queryMemoryEvents({ session_id: "ses-a", limit: 2, offset: 2 });
    expect(page1.map((r) => r.record_id)).toEqual(["m_0", "m_1"]);
    expect(page2.map((r) => r.record_id)).toEqual(["m_2", "m_3"]);
  });

  it("keeps superseded rows after the record is replaced (append-only)", () => {
    // Same record_id appears twice across its lifetime — nothing is overwritten.
    store.appendMemoryEvent(makeEvent({ record_id: "m_x", content: "v1" }));
    store.appendMemoryEvent(
      makeEvent({ op: "superseded", record_id: "m_x", content: "v1", superseded_by: "m_y" }),
    );
    const rows = store.queryMemoryEvents({ record_id: "m_x" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.op)).toEqual(["created", "superseded"]);
  });
});
