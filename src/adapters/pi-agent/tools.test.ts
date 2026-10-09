import { describe, expect, it, vi } from "vitest";
import { PiAgentMemoryTools } from "./tools.js";

describe("PiAgentMemoryTools", () => {
  it("maps memory_search to Gateway searchMemories", async () => {
    const client = {
      searchMemories: vi.fn(async () => ({ results: "memory result", total: 1, strategy: "fts" })),
      searchConversations: vi.fn(),
    };
    const tools = new PiAgentMemoryTools(client);

    await expect(tools.memorySearch({ query: "adapter", limit: 100 })).resolves.toBe("memory result");
    expect(client.searchMemories).toHaveBeenCalledWith({ query: "adapter", limit: 20, type: undefined, scene: undefined });
  });

  it("maps conversation_search to Gateway searchConversations", async () => {
    const client = {
      searchMemories: vi.fn(),
      searchConversations: vi.fn(async () => ({ results: "conversation result", total: 1 })),
    };
    const tools = new PiAgentMemoryTools(client);

    await expect(tools.conversationSearch({ query: "why", sessionKey: "s" })).resolves.toBe("conversation result");
    expect(client.searchConversations).toHaveBeenCalledWith({ query: "why", limit: 5, session_key: "s" });
  });

  it("keeps context_get explicitly reserved in v1", () => {
    const client = { searchMemories: vi.fn(), searchConversations: vi.fn() };
    const tools = new PiAgentMemoryTools(client);

    expect(tools.contextGet({})).toContain("reserved for the next stage");
  });
});