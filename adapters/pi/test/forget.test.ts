import { describe, expect, it, vi } from "vitest";
import {
  deleteForgetCandidates,
  formatForgetCandidates,
  searchForgetCandidates,
} from "../src/forget.js";

function memoryClient() {
  return {
    searchAtomic: vi.fn(),
    searchConversation: vi.fn(),
    deleteAtomic: vi.fn(),
    deleteConversation: vi.fn(),
  };
}

describe("searchForgetCandidates", () => {
  it("merges L1 memories and L0 messages, redacting and dropping empty/ID-less items", async () => {
    const memory = memoryClient();
    memory.searchAtomic.mockResolvedValue({
      items: [
        { id: "a1", type: "preference", content: "uses sk-mem-abcdefghijklmnopqrstuvwxyz", score: 0.9 },
        { id: "a2", type: "fact", content: "   ", score: 0.8 },
      ],
    });
    memory.searchConversation.mockResolvedValue({
      messages: [
        { id: "m1", role: "user", content: "I prefer tabs", score: 0.7 },
        { role: "assistant", content: "no id, skipped", score: 0.6 },
      ],
    });

    const result = await searchForgetCandidates(memory as never, "prefer");
    expect(result.map((c) => c.id)).toEqual(["a1", "m1"]);
    expect(result[0]!).toMatchObject({ kind: "L1", role: "memory" });
    expect(result[0]!.content).not.toContain("sk-mem-");
    expect(result[1]!).toMatchObject({ kind: "L0", role: "user" });
  });
});

describe("formatForgetCandidates", () => {
  it("labels each kind and truncates long content for preview", () => {
    const formatted = formatForgetCandidates([
      { id: "a", kind: "L1", role: "memory", content: "x".repeat(500) },
      { id: "b", kind: "L0", role: "user", content: "hello" },
    ]);
    expect(formatted[0]!).toContain("1. [L1 memory]");
    expect(formatted[0]!.length).toBeLessThan(300);
    expect(formatted[1]!).toBe("2. [L0 user] hello");
  });
});

describe("deleteForgetCandidates", () => {
  it("dedupes ids and deletes each layer independently", async () => {
    const memory = memoryClient();
    memory.deleteAtomic.mockResolvedValue({ deleted_count: 2 });
    memory.deleteConversation.mockResolvedValue({ deleted_count: 3 });

    const result = await deleteForgetCandidates(memory as never, [
      { id: "a1", kind: "L1", role: "memory", content: "x" },
      { id: "a1", kind: "L1", role: "memory", content: "x" },
      { id: "m1", kind: "L0", role: "user", content: "y" },
      { id: "m2", kind: "L0", role: "user", content: "z" },
    ]);

    expect(result).toEqual({ l1Deleted: 2, l0Deleted: 3 });
    expect(memory.deleteAtomic).toHaveBeenCalledWith({ ids: ["a1"] });
    expect(memory.deleteConversation).toHaveBeenCalledWith({ message_ids: ["m1", "m2"] });
  });

  it("skips the delete call for a layer with no candidates", async () => {
    const memory = memoryClient();
    memory.deleteAtomic.mockResolvedValue({ deleted_count: 1 });

    const result = await deleteForgetCandidates(memory as never, [
      { id: "a1", kind: "L1", role: "memory", content: "x" },
    ]);

    expect(result).toEqual({ l1Deleted: 1, l0Deleted: 0 });
    expect(memory.deleteConversation).not.toHaveBeenCalled();
  });
});
