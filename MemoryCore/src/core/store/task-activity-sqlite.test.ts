import { afterEach, describe, expect, it } from "vitest";

import { VectorStore } from "./sqlite.js";

describe("SQLite L0 task activity aggregation", () => {
  let store: VectorStore | undefined;

  afterEach(() => store?.close());

  it("groups by the exact activity tuple and counts distinct sessions", () => {
    store = new VectorStore(":memory:", 0);
    store.init();
    const base = {
      sessionKey: "key",
      teamId: "team-a",
      userId: "user-a",
      agentId: "agent-a",
      taskId: "task-a",
      role: "user",
      messageText: "not returned",
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
    store.upsertL0({ ...base, id: "r1", sessionId: "s1", timestamp: 100 });
    store.upsertL0({ ...base, id: "r2", sessionId: "s1", timestamp: 200 });
    store.upsertL0({ ...base, id: "r3", sessionId: "s2", timestamp: 300 });
    store.upsertL0({ ...base, id: "r4", userId: "user-b", sessionId: "s3", timestamp: 400 });

    const result = store.aggregateL0TaskActivity({
      teamId: "team-a", taskIds: ["task-a"], userId: "user-a", timeStartMs: 150,
    });

    expect(result).toEqual({
      items: [{
        team_id: "team-a",
        task_id: "task-a",
        user_id: "user-a",
        agent_id: "agent-a",
        session_count: 2,
        l0_message_count: 2,
        first_seen_at: new Date(200).toISOString(),
        last_seen_at: new Date(300).toISOString(),
      }],
      completeness: "complete",
      truncated: false,
      scanned_records: 2,
    });
  });

  it("creates the covering task activity index", () => {
    store = new VectorStore(":memory:", 0);
    store.init();
    const db = (store as unknown as { db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } } }).db;
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT team_id, task_id, user_id, agent_id, COUNT(DISTINCT session_id)
      FROM l0_conversations
      WHERE team_id = ? AND task_id IN (?)
      GROUP BY team_id, task_id, user_id, agent_id
    `).all("team-a", "task-a");
    expect(JSON.stringify(plan)).toContain("idx_l0_task_activity");
  });
});
