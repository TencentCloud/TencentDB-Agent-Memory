import { describe, expect, it, vi } from "vitest";

import { handleTaskActivityAggregate } from "./activity-handlers.js";

const auth = { apiKey: "test", serviceId: "test-service" };

describe("task activity aggregate handler", () => {
  it("requires a bounded team and task scope", async () => {
    const result = await handleTaskActivityAggregate(
      { team_id: "team-a", task_ids: [] }, auth, "req-1", {},
    );
    expect(result.code).toBe(400);
  });

  it("returns metadata-only aggregate rows from the store", async () => {
    const aggregateL0TaskActivity = vi.fn().mockResolvedValue({
      items: [{
        team_id: "team-a",
        task_id: "task-a",
        user_id: "user-a",
        agent_id: "agent-a",
        session_count: 1,
        l0_message_count: 2,
      }],
      completeness: "complete",
      truncated: false,
      scanned_records: 2,
    });
    const result = await handleTaskActivityAggregate(
      { team_id: "team-a", task_ids: ["task-a", "task-a"], user_id: "user-a" },
      auth,
      "req-2",
      { getStore: () => ({ aggregateL0TaskActivity }) },
    );

    expect(result.code).toBe(0);
    expect(aggregateL0TaskActivity).toHaveBeenCalledWith({
      teamId: "team-a",
      taskIds: ["task-a"],
      userId: "user-a",
      timeStartMs: undefined,
      timeEndMs: undefined,
    });
    expect(JSON.stringify(result)).not.toMatch(/message_text|embedding|content/);
  });

  it("resolves the store by serviceId without falling back across instances", async () => {
    const resultFor = (agentId: string) => ({
      items: [{
        team_id: "team-a", task_id: "task-a", user_id: "user-a", agent_id: agentId,
        session_count: 1, l0_message_count: 1,
      }],
      completeness: "complete" as const,
      truncated: false,
    });
    const stores = {
      "service-a": { aggregateL0TaskActivity: vi.fn().mockResolvedValue(resultFor("agent-a")) },
      "service-b": { aggregateL0TaskActivity: vi.fn().mockResolvedValue(resultFor("agent-b")) },
    };
    const resolveStore = vi.fn(async (serviceId: string) => ({
      store: stores[serviceId as keyof typeof stores],
    }));
    const getStore = vi.fn(() => stores["service-a"]);

    const first = await handleTaskActivityAggregate(
      { team_id: "team-a", task_ids: ["task-a"] },
      { apiKey: "test", serviceId: "service-a" },
      "req-a",
      { resolveStore, getStore },
    );
    const second = await handleTaskActivityAggregate(
      { team_id: "team-a", task_ids: ["task-a"] },
      { apiKey: "test", serviceId: "service-b" },
      "req-b",
      { resolveStore, getStore },
    );

    expect(resolveStore).toHaveBeenNthCalledWith(1, "service-a");
    expect(resolveStore).toHaveBeenNthCalledWith(2, "service-b");
    expect(getStore).not.toHaveBeenCalled();
    expect((first.data as { items: Array<{ agent_id: string }> }).items[0]?.agent_id).toBe("agent-a");
    expect((second.data as { items: Array<{ agent_id: string }> }).items[0]?.agent_id).toBe("agent-b");
  });
});
