import { describe, expect, it, vi } from "vitest";
import { conversationSearch, memorySearch } from "../src/tools.js";

function memoryClient() {
  return {
    searchAtomic: vi.fn(),
    searchConversation: vi.fn(),
  };
}

function text(result: Awaited<ReturnType<typeof memorySearch>>): string {
  const item = result.content[0];
  if (!item || item.type !== "text") throw new Error("Expected text result");
  return item.text;
}

describe("read-only memory tools", () => {
  it("rejects an empty structured-memory query without calling the SDK", async () => {
    const memory = memoryClient();
    expect(text(await memorySearch(memory as never, { query: "  " }))).toBe("Query cannot be empty.");
    expect(memory.searchAtomic).not.toHaveBeenCalled();
  });

  it("formats structured-memory hits with type and score", async () => {
    const memory = memoryClient();
    memory.searchAtomic.mockResolvedValue({ items: [{ type: "preference", score: 0.9876, content: "Use TypeScript." }] });
    const result = text(await memorySearch(memory as never, { query: "language", limit: 2, type: "preference" }));
    expect(result).toContain("[preference]");
    expect(result).toContain("score: 0.988");
    expect(memory.searchAtomic).toHaveBeenCalledWith({ query: "language", limit: 2, type: "preference" });
  });

  it("returns a normal no-match message for empty search results", async () => {
    const memory = memoryClient();
    memory.searchAtomic.mockResolvedValue({ items: [] });
    memory.searchConversation.mockResolvedValue({ messages: [] });
    expect(text(await memorySearch(memory as never, { query: "missing" }))).toBe("No matching memories found.");
    expect(text(await conversationSearch(memory as never, { query: "missing" }))).toBe("No matching conversation messages found.");
  });

  it("formats conversations with role and timestamp and maps session_key", async () => {
    const memory = memoryClient();
    memory.searchConversation.mockResolvedValue({
      messages: [{ role: "assistant", timestamp: "2026-08-13T00:00:00Z", score: 0.5, content: "Earlier answer." }],
    });
    const result = text(await conversationSearch(memory as never, { query: "answer", session_key: "pi-old" }));
    expect(result).toContain("[assistant]");
    expect(result).toContain("[2026-08-13T00:00:00Z]");
    expect(memory.searchConversation).toHaveBeenCalledWith({ query: "answer", session_id: "pi-old" });
  });

  it("turns SDK errors into text and redacts sensitive returned content", async () => {
    const memory = memoryClient();
    memory.searchAtomic.mockRejectedValue(new Error("offline sk-mem-abcdefghi"));
    expect(text(await memorySearch(memory as never, { query: "x" }))).toContain("Memory search failed:");
    expect(text(await memorySearch(memory as never, { query: "x" }))).not.toContain("sk-mem-abcdefghi");
    memory.searchConversation.mockResolvedValue({ messages: [{ role: "user", content: "Bearer abc.def.ghi" }] });
    expect(text(await conversationSearch(memory as never, { query: "token" }))).toContain("[REDACTED]");
  });
});
