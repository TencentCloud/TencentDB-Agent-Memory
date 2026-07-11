import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VectorStore, _resetJiebaForTest, _setJiebaForTest } from "./sqlite.js";
import { TcvdbMemoryStore } from "./tcvdb.js";

describe("backend keyword query boundary", () => {
  beforeEach(() => {
    _setJiebaForTest(null);
  });

  afterEach(() => {
    _resetJiebaForTest();
  });

  it("builds SQLite MATCH syntax inside the L1 store", () => {
    const store = new VectorStore(":memory:", 0);
    const search = vi.spyOn(store, "searchL1Fts").mockReturnValue([]);

    try {
      store.searchL1Keyword("alpha beta", 7);
      expect(search).toHaveBeenCalledWith('"alpha" OR "beta"', 7);
    } finally {
      store.close();
    }
  });

  it("builds SQLite MATCH syntax inside the L0 store", () => {
    const store = new VectorStore(":memory:", 0);
    const search = vi.spyOn(store, "searchL0Fts").mockReturnValue([]);

    try {
      store.searchL0Keyword("alpha beta", 9);
      expect(search).toHaveBeenCalledWith('"alpha" OR "beta"', 9);
    } finally {
      store.close();
    }
  });

  it("keeps raw L1 text for TCVDB embedding and BM25 search", async () => {
    const store = createTcvdbStore();
    const search = vi.spyOn(store, "searchL1HybridAsync").mockResolvedValue([]);

    await store.searchL1Keyword("  alpha beta  ", 7);

    expect(search).toHaveBeenCalledWith({ queryText: "alpha beta", topK: 7 });
  });

  it("keeps raw L0 text for TCVDB embedding and BM25 search", async () => {
    const store = createTcvdbStore();
    const search = vi.spyOn(store, "searchL0HybridAsync").mockResolvedValue([]);

    await store.searchL0Keyword("  alpha beta  ", 9);

    expect(search).toHaveBeenCalledWith({ queryText: "alpha beta", topK: 9 });
  });

  it("does not dispatch whitespace-only keyword queries", async () => {
    const store = createTcvdbStore();
    const search = vi.spyOn(store, "searchL1HybridAsync").mockResolvedValue([]);

    await expect(store.searchL1Keyword("   ", 5)).resolves.toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });
});

function createTcvdbStore(): TcvdbMemoryStore {
  return new TcvdbMemoryStore({
    url: "http://127.0.0.1:1",
    username: "test",
    apiKey: "test",
    database: "test",
    embeddingModel: "test",
    timeout: 1,
  });
}
