import { describe, expect, it, vi } from "vitest";

import { TcvdbMemoryStore } from "./tcvdb.js";

function makeStore(query: ReturnType<typeof vi.fn>): TcvdbMemoryStore {
  const store = new TcvdbMemoryStore({
    url: "http://unused.invalid",
    username: "test",
    apiKey: "test",
    database: "test",
    embeddingModel: "test",
    timeout: 100,
  });
  (store as unknown as { client: { query: typeof query } }).client = { query };
  return store;
}

describe("TCVDB L0 task activity aggregation", () => {
  it("uses scoped metadata-only pages", async () => {
    const query = vi.fn().mockResolvedValueOnce({ documents: [{
      team_id: "team-a", task_id: "task-a", user_id: "user-a", agent_id: "agent-a",
      session_id: "session-a", timestamp: 100,
    }] });
    const result = await makeStore(query).aggregateL0TaskActivity({
      teamId: "team-a", taskIds: ["task-a"], userId: "user-a",
    });

    const request = query.mock.calls[0][1];
    expect(request.filter).toContain('team_id = "team-a"');
    expect(request.filter).toContain('task_id = "task-a"');
    expect(request.filter).toContain('user_id = "user-a"');
    expect(request.outputFields).not.toContain("message_text");
    expect(request.outputFields).not.toContain("vector");
    expect(result.completeness).toBe("complete");
    expect(result.items[0]).toMatchObject({ session_count: 1, l0_message_count: 1 });
  });

  it("marks counts partial when the hard cap is reached", async () => {
    const page = Array.from({ length: 500 }, (_, index) => ({
      team_id: "team-a", task_id: "task-a", user_id: "user-a", agent_id: "agent-a",
      session_id: `session-${index}`, timestamp: index + 1,
    }));
    const query = vi.fn().mockResolvedValue({ documents: page });
    const result = await makeStore(query).aggregateL0TaskActivity({ teamId: "team-a", taskIds: ["task-a"] });

    expect(query).toHaveBeenCalledTimes(20);
    expect(result).toMatchObject({ completeness: "partial", truncated: true, scanned_records: 10_000 });
  });
});
