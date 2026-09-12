import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryOperations, MemoryOperationError } from "./memory-operations.js";
import type { TdaiCore } from "../core/tdai-core.js";
import type { Logger } from "../core/types.js";

// ============================
// Test doubles
// ============================

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Minimal TdaiCore stand-in — only the five methods MemoryOperations calls.
 * Cast through unknown because TdaiCore's real surface is much larger.
 */
function makeCore() {
  return {
    handleBeforeRecall: vi.fn().mockResolvedValue({
      appendSystemContext: "ctx",
      recalledL1Memories: [{ content: "m", score: 1, type: "episodic" }],
      recallStrategy: "hybrid",
    }),
    handleTurnCommitted: vi.fn().mockResolvedValue({
      l0RecordedCount: 2,
      schedulerNotified: true,
      l0VectorsWritten: 2,
      filteredMessages: [],
    }),
    searchMemories: vi.fn().mockResolvedValue({ text: "hit", total: 1, strategy: "vector" }),
    searchConversations: vi.fn().mockResolvedValue({ text: "conv", total: 3 }),
    handleSessionEnd: vi.fn().mockResolvedValue(undefined),
  };
}

type FakeCore = ReturnType<typeof makeCore>;

function makeOps(core: FakeCore) {
  return new MemoryOperations(core as unknown as TdaiCore, makeLogger(), "[test]");
}

describe("MemoryOperations", () => {
  let core: FakeCore;
  let ops: MemoryOperations;

  beforeEach(() => {
    core = makeCore();
    ops = makeOps(core);
  });

  // ============================
  // Validation — the contract both transports rely on
  // ============================

  describe("validation", () => {
    it("rejects a missing query on recall", async () => {
      await expect(ops.recall({ query: "", sessionKey: "s1" })).rejects.toThrow(
        MemoryOperationError,
      );
      expect(core.handleBeforeRecall).not.toHaveBeenCalled();
    });

    it("rejects a whitespace-only query", async () => {
      await expect(ops.recall({ query: "   ", sessionKey: "s1" })).rejects.toThrow(
        "Missing required field: query",
      );
    });

    it("rejects a missing session key on recall", async () => {
      await expect(ops.recall({ query: "q", sessionKey: "" })).rejects.toThrow(
        "Missing required field: session_key",
      );
    });

    it("reports each missing capture field by name", async () => {
      await expect(
        ops.capture({ userText: "", assistantText: "a", sessionKey: "s1" }),
      ).rejects.toThrow("Missing required field: user_text");

      await expect(
        ops.capture({ userText: "u", assistantText: "", sessionKey: "s1" }),
      ).rejects.toThrow("Missing required field: assistant_text");

      await expect(
        ops.capture({ userText: "u", assistantText: "a", sessionKey: "" }),
      ).rejects.toThrow("Missing required field: session_key");
    });

    it("rejects an empty query on both search operations", async () => {
      await expect(ops.searchMemories({ query: "" })).rejects.toThrow(MemoryOperationError);
      await expect(ops.searchConversations({ query: "" })).rejects.toThrow(MemoryOperationError);
    });

    it("rejects an empty session key on sessionEnd", async () => {
      await expect(ops.sessionEnd("")).rejects.toThrow(MemoryOperationError);
      expect(core.handleSessionEnd).not.toHaveBeenCalled();
    });

    it("carries a 400 status so HTTP can map it without re-deriving intent", async () => {
      const err = await ops.recall({ query: "", sessionKey: "s" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MemoryOperationError);
      expect((err as MemoryOperationError).statusCode).toBe(400);
    });
  });

  // ============================
  // Delegation
  // ============================

  describe("recall", () => {
    it("passes query and session key through and returns the core result", async () => {
      const result = await ops.recall({ query: "what did I say", sessionKey: "s1" });
      expect(core.handleBeforeRecall).toHaveBeenCalledWith("what did I say", "s1");
      expect(result.appendSystemContext).toBe("ctx");
      expect(result.recallStrategy).toBe("hybrid");
    });
  });

  describe("capture", () => {
    it("synthesizes a user/assistant message pair when none is given", async () => {
      await ops.capture({ userText: "u", assistantText: "a", sessionKey: "s1" });
      const turn = core.handleTurnCommitted.mock.calls[0]![0];
      expect(turn.messages).toEqual([
        { role: "user", content: "u" },
        { role: "assistant", content: "a" },
      ]);
    });

    it("preserves an explicit message list instead of synthesizing one", async () => {
      const messages = [{ role: "user", content: "one" }, { role: "tool", content: "two" }];
      await ops.capture({ userText: "u", assistantText: "a", sessionKey: "s1", messages });
      expect(core.handleTurnCommitted.mock.calls[0]![0].messages).toBe(messages);
    });

    it("defaults sessionId to sessionKey", async () => {
      await ops.capture({ userText: "u", assistantText: "a", sessionKey: "s1" });
      expect(core.handleTurnCommitted.mock.calls[0]![0].sessionId).toBe("s1");
    });

    it("keeps an explicit sessionId distinct from the session key", async () => {
      await ops.capture({
        userText: "u",
        assistantText: "a",
        sessionKey: "s1",
        sessionId: "sub-7",
      });
      const turn = core.handleTurnCommitted.mock.calls[0]![0];
      expect(turn.sessionId).toBe("sub-7");
      expect(turn.sessionKey).toBe("s1");
    });

    it("honours a caller-supplied startedAt (hook replay keeps original timing)", async () => {
      await ops.capture({
        userText: "u",
        assistantText: "a",
        sessionKey: "s1",
        startedAt: 1234,
      });
      expect(core.handleTurnCommitted.mock.calls[0]![0].startedAt).toBe(1234);
    });
  });

  describe("search", () => {
    it("forwards all memory search filters", async () => {
      const result = await ops.searchMemories({
        query: "q",
        limit: 3,
        type: "episodic",
        scene: "work",
      });
      expect(core.searchMemories).toHaveBeenCalledWith({
        query: "q",
        limit: 3,
        type: "episodic",
        scene: "work",
      });
      expect(result.total).toBe(1);
      expect(result.strategy).toBe("vector");
    });

    it("maps session_key to sessionKey for conversation search", async () => {
      await ops.searchConversations({ query: "q", limit: 2, sessionKey: "s9" });
      expect(core.searchConversations).toHaveBeenCalledWith({
        query: "q",
        limit: 2,
        sessionKey: "s9",
      });
    });
  });

  describe("sessionEnd", () => {
    it("flushes the given session", async () => {
      await ops.sessionEnd("s1");
      expect(core.handleSessionEnd).toHaveBeenCalledWith("s1");
    });
  });

  // ============================
  // Error propagation
  // ============================

  it("lets core failures propagate rather than swallowing them", async () => {
    core.handleBeforeRecall.mockRejectedValue(new Error("vector store down"));
    await expect(ops.recall({ query: "q", sessionKey: "s" })).rejects.toThrow(
      "vector store down",
    );
  });
});
