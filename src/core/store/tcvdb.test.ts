import { afterEach, describe, expect, it, vi } from "vitest";

import { TcvdbMemoryStore } from "./tcvdb.js";
import { TcvdbClient } from "./tcvdb-client.js";

const DATABASE = "checkpoint_unit";
const L0_COLLECTION = `${DATABASE}_l0_conversations`;
const L1_COLLECTION = `${DATABASE}_l1_memories`;

function createStore(): TcvdbMemoryStore {
  return new TcvdbMemoryStore({
    url: "http://tcvdb.invalid",
    username: "test-user",
    apiKey: "test-key",
    database: DATABASE,
    embeddingModel: "test-model",
    timeout: 100,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TcvdbMemoryStore strict checkpoint counts", () => {
  it("uses the L1 total as l1Since when no timestamp is provided", async () => {
    const count = vi.spyOn(TcvdbClient.prototype, "count")
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(7);
    const store = createStore();

    await expect(store.readCheckpointCountsStrict()).resolves.toEqual({
      l0: 4,
      l1: 7,
      l1Since: 7,
    });
    expect(count).toHaveBeenCalledTimes(2);
    expect(count).toHaveBeenNthCalledWith(1, L0_COLLECTION);
    expect(count).toHaveBeenNthCalledWith(2, L1_COLLECTION);
  });

  it("counts post-persona L1 records with the correct epoch filter", async () => {
    const updatedAfter = "2026-07-22T03:04:05.678Z";
    const epochMs = Date.parse(updatedAfter);
    const count = vi.spyOn(TcvdbClient.prototype, "count")
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(3);
    const store = createStore();

    await expect(store.readCheckpointCountsStrict(updatedAfter)).resolves.toEqual({
      l0: 5,
      l1: 9,
      l1Since: 3,
    });
    expect(count).toHaveBeenCalledTimes(3);
    expect(count).toHaveBeenNthCalledWith(1, L0_COLLECTION);
    expect(count).toHaveBeenNthCalledWith(2, L1_COLLECTION);
    expect(count).toHaveBeenNthCalledWith(
      3,
      L1_COLLECTION,
      `updated_time_ms > ${epochMs}`,
    );
  });

  it("throws without counting when the Store is degraded", async () => {
    const count = vi.spyOn(TcvdbClient.prototype, "count");
    const store = createStore();
    (store as unknown as { degraded: boolean }).degraded = true;

    await expect(store.readCheckpointCountsStrict()).rejects.toThrow("TCVDB Store is degraded");
    expect(count).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])(
    "propagates a failure from count call %i",
    async (failingCall) => {
      let invocation = 0;
      const count = vi.spyOn(TcvdbClient.prototype, "count").mockImplementation(async () => {
        invocation += 1;
        if (invocation === failingCall) throw new Error(`count ${failingCall} failed`);
        return invocation === 1 ? 4 : invocation === 2 ? 7 : 2;
      });
      const store = createStore();

      await expect(
        store.readCheckpointCountsStrict("2026-07-22T03:04:05.678Z"),
      ).rejects.toThrow(`count ${failingCall} failed`);
      expect(count).toHaveBeenCalled();
    },
  );
});
