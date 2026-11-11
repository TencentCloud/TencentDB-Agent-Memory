import { describe, expect, it, vi } from "vitest";
import type { MemoryRecord } from "../record/l1-writer.js";
import { TcvdbMemoryStore } from "./tcvdb/memory-store.js";

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    content: "edited content",
    type: "persona",
    priority: 50,
    scene_name: "default",
    source_message_ids: [],
    metadata: {},
    timestamps: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:01:00.000Z",
    version: 3,
    sessionKey: "session-key",
    sessionId: "session-id",
    teamId: "team-1",
    userId: "user-1",
    agentId: "agent-1",
    taskId: "task-1",
    ...overrides,
  };
}

function makeStore() {
  const store = new TcvdbMemoryStore({
    url: "https://example.invalid",
    username: "user",
    apiKey: "key",
    database: "test",
    embeddingEnabled: false,
    embeddingModel: "none",
    timeout: 1000,
  });
  const client = {
    update: vi.fn(),
    query: vi.fn(),
  };
  // Bypass remote collection initialization and replace the REST client with a deterministic fake.
  Object.assign(store as any, { client, _initPromise: Promise.resolve(), degraded: false });
  return { store, client };
}

describe("TcvdbMemoryStore.compareAndSwapL1", () => {
  it("uses one server-side version-filtered update", async () => {
    const { store, client } = makeStore();
    client.update.mockResolvedValue(1);

    const result = await store.compareAndSwapL1(makeRecord({ version: 999 }), 2, undefined);

    expect(result).toEqual({ status: "updated", version: 3 });
    expect(client.update).toHaveBeenCalledTimes(1);
    expect(client.update).toHaveBeenCalledWith(
      "test_l1_memories",
      {
        documentIds: ["memory-1"],
        filter:
          'version = 2 and team_id = "team-1" and user_id = "user-1" and agent_id = "agent-1" and task_id = "task-1"',
        update: expect.objectContaining({ text: "edited content", version: 3 }),
      },
      { maxRetries: 0 },
    );
  });

  it("reports the current version after a rejected stale update", async () => {
    const { store, client } = makeStore();
    client.update.mockResolvedValue(0);
    client.query.mockResolvedValue({ documents: [{ id: "memory-1", version: 4 }] });

    const result = await store.compareAndSwapL1(makeRecord({ version: 999 }), 2, undefined);

    expect(result).toEqual({ status: "conflict", currentVersion: 4 });
    expect(client.query).toHaveBeenCalledWith("test_l1_memories", {
      documentIds: ["memory-1"],
      retrieveVector: false,
      outputFields: ["version"],
      limit: 1,
    });
  });

  it("distinguishes a missing document", async () => {
    const { store, client } = makeStore();
    client.update.mockResolvedValue(0);
    client.query.mockResolvedValue({ documents: [] });

    const result = await store.compareAndSwapL1(makeRecord({ version: 999 }), 2, undefined);

    expect(result).toEqual({ status: "not_found" });
  });
  it("does not retry an ambiguous update failure or query a misleading result", async () => {
    const { store, client } = makeStore();
    client.update.mockRejectedValue(new Error("response lost after possible commit"));
    expect(await store.compareAndSwapL1(makeRecord(), 2, undefined)).toEqual({ status: "failed" });
    expect(client.update).toHaveBeenCalledTimes(1);
    expect(client.query).not.toHaveBeenCalled();
  });

  it.each([Number.MAX_SAFE_INTEGER, -1, NaN, 1.5])("rejects unsafe internal expected version %s", async (version) => {
    const { store, client } = makeStore();
    expect(await store.compareAndSwapL1(makeRecord(), version, undefined)).toEqual({ status: "failed" });
    expect(client.update).not.toHaveBeenCalled();
  });

});
