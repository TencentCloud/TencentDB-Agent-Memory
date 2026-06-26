import { describe, expect, it } from "vitest";
import { TcvdbMemoryStore } from "./tcvdb.js";

function createStoreWithCapturedQueryFilters(): {
  store: TcvdbMemoryStore;
  filters: string[];
} {
  const filters: string[] = [];
  const store = new TcvdbMemoryStore({
    url: "http://127.0.0.1",
    username: "root",
    apiKey: "test-key",
    database: "testdb",
    embeddingModel: "bge-large-zh",
    timeout: 1000,
  });

  Object.assign(store as unknown as Record<string, unknown>, {
    client: {
      query: async (_collection: string, params: Record<string, unknown>) => {
        filters.push(String(params.filter ?? ""));
        return { documents: [] };
      },
    },
    _initPromise: Promise.resolve(),
  });

  return { store, filters };
}

describe("TcvdbMemoryStore filter expressions", () => {
  it("escapes session string literals before building query filters", async () => {
    const { store, filters } = createStoreWithCapturedQueryFilters();
    const sessionKey = 'alpha" or session_key = "beta';
    const sessionId = 'sid\\quote" or session_id = "other';
    const updatedAfter = "2026-01-02T03:04:05.000Z";

    await store.queryL1Records({ sessionKey, sessionId, updatedAfter });
    await store.queryL0ForL1(sessionKey, 123);

    expect(filters).toEqual([
      `session_key = "alpha\\" or session_key = \\"beta" and session_id = "sid\\\\quote\\" or session_id = \\"other" and updated_time_ms > ${Date.parse(updatedAfter)}`,
      `session_key = "alpha\\" or session_key = \\"beta" and recorded_at_ms > 123`,
    ]);
  });
});
