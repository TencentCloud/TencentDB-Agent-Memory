import { describe, expect, it, vi } from "vitest";
import { executeConversationSearch } from "./conversation-search.js";
import { executeMemorySearch } from "./memory-search.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("session-prefix search filters", () => {
  it("filters L1 memory search results by session-key prefix", async () => {
    const rows = [
      ...Array.from({ length: 700 }, (_, i) => l1Result(`other-${i}`, "codex:def456:session-b")),
      l1Result("a", "codex:abc123:session-a"),
      l1Result("c", "codex-import:abc123:session-c"),
    ];
    const prefixes = ["codex:abc123:", "codex-import:abc123:"];
    const countL1 = vi.fn(() => rows.length);
    const searchL1Fts = vi.fn((_query: string, limit: number, scope?: { sessionKeyPrefixes?: string[] }) =>
      rows
        .filter((row) => scope?.sessionKeyPrefixes?.some((prefix) => row.session_key.startsWith(prefix)))
        .slice(0, limit),
    );
    const vectorStore = {
      isFtsAvailable: () => true,
      countL1,
      searchL1Fts,
    };

    const result = await executeMemorySearch({
      query: "project note",
      limit: 2,
      sessionKeyPrefixes: prefixes,
      vectorStore: vectorStore as any,
      logger,
    });

    expect(result.results.map((item) => item.id)).toEqual(["a", "c"]);
    expect(countL1).not.toHaveBeenCalled();
    expect(searchL1Fts).toHaveBeenCalledTimes(1);
    expect(searchL1Fts.mock.calls[0][1]).toBe(50);
    expect(searchL1Fts.mock.calls[0][2]).toEqual({ sessionKeyPrefixes: prefixes });
  });

  it("leaves L1 search unscoped when session-key prefixes are empty or undefined", async () => {
    for (const prefixes of [undefined, []]) {
      const rows = [
        l1Result("a", "codex:abc123:session-a"),
        l1Result("b", "codex:def456:session-b"),
      ];
      const searchL1Fts = vi.fn((_query: string, limit: number) => rows.slice(0, limit));
      const vectorStore = {
        isFtsAvailable: () => true,
        searchL1Fts,
      };

      const result = await executeMemorySearch({
        query: "project note",
        limit: 2,
        sessionKeyPrefixes: prefixes,
        vectorStore: vectorStore as any,
        logger,
      });

      expect(result.results.map((item) => item.id)).toEqual(["a", "b"]);
      expect(searchL1Fts.mock.calls[0][1]).toBe(6);
      expect(searchL1Fts.mock.calls[0][2]).toBeUndefined();
    }
  });

  it("filters L0 conversation search results by session-key prefix", async () => {
    const rows = [
      ...Array.from({ length: 700 }, (_, i) => l0Result(`other-${i}`, "codex:def456:session-b")),
      l0Result("a", "codex:abc123:session-a"),
      l0Result("c", "codex-import:abc123:session-c"),
    ];
    const prefixes = ["codex:abc123:", "codex-import:abc123:"];
    const countL0 = vi.fn(() => rows.length);
    const searchL0Fts = vi.fn((_query: string, limit: number, scope?: { sessionKeyPrefixes?: string[] }) =>
      rows
        .filter((row) => scope?.sessionKeyPrefixes?.some((prefix) => row.session_key.startsWith(prefix)))
        .slice(0, limit),
    );
    const vectorStore = {
      isFtsAvailable: () => true,
      countL0,
      searchL0Fts,
    };

    const result = await executeConversationSearch({
      query: "previous command",
      limit: 2,
      sessionKeyPrefixes: prefixes,
      vectorStore: vectorStore as any,
      logger,
    });

    expect(result.results.map((item) => item.id)).toEqual(["a", "c"]);
    expect(countL0).not.toHaveBeenCalled();
    expect(searchL0Fts).toHaveBeenCalledTimes(1);
    expect(searchL0Fts.mock.calls[0][1]).toBe(50);
    expect(searchL0Fts.mock.calls[0][2]).toEqual({ sessionKeyPrefixes: prefixes });
  });

  it("leaves L0 search unscoped when session-key prefixes are empty or undefined", async () => {
    for (const prefixes of [undefined, []]) {
      const rows = [
        l0Result("a", "codex:abc123:session-a"),
        l0Result("b", "codex:def456:session-b"),
      ];
      const searchL0Fts = vi.fn((_query: string, limit: number) => rows.slice(0, limit));
      const vectorStore = {
        isFtsAvailable: () => true,
        searchL0Fts,
      };

      const result = await executeConversationSearch({
        query: "previous command",
        limit: 2,
        sessionKeyPrefixes: prefixes,
        vectorStore: vectorStore as any,
        logger,
      });

      expect(result.results.map((item) => item.id)).toEqual(["a", "b"]);
      expect(searchL0Fts.mock.calls[0][1]).toBe(6);
      expect(searchL0Fts.mock.calls[0][2]).toBeUndefined();
    }
  });
});

function l1Result(id: string, sessionKey: string) {
  return {
    record_id: id,
    content: `memory ${id}`,
    type: "episodic",
    priority: 2,
    scene_name: "test",
    score: 1,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: sessionKey,
    session_id: id,
    metadata_json: "{}",
  };
}

function l0Result(id: string, sessionKey: string) {
  return {
    record_id: id,
    session_key: sessionKey,
    role: "assistant",
    message_text: `conversation ${id}`,
    score: 1,
    recorded_at: "",
  };
}
