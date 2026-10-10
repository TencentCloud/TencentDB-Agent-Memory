import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { V3MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";
import { createClaudeCodeMcpServer } from "../src/mcp/server.js";
import { createKnowledgeTools, KnowledgeServiceClient } from "../src/knowledge.js";

function fakeMemory(): V3MemoryClient {
  return {
    searchAtomic: vi.fn().mockResolvedValue({ items: [{ id: "m1", type: "episodic", content: "Deployed v1.9", score: 0.8 }] }),
    searchConversation: vi.fn().mockResolvedValue({ messages: [{ role: "assistant", content: "[tool_use …]", timestamp: "2026-09-06T00:00:00Z", score: 0.7 }] }),
    readScenario: vi.fn().mockResolvedValue({ path: "scene/a.md", content: "# A", created_at: null, updated_at: null }),
    addConversation: vi.fn().mockResolvedValue({ accepted_ids: ["c1"], total_count: 9 }),
  } as unknown as V3MemoryClient;
}

async function connect(server: ReturnType<typeof createClaudeCodeMcpServer>) {
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe("createClaudeCodeMcpServer", () => {
  it("exposes memory tools, and wiki tools only when a Knowledge Service is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { items: [{ wiki_id: "w1", name: "team" }] } })));
    const knowledge = createKnowledgeTools({ baseUrl: "http://knowledge.test", serviceId: "default", teamId: "t1", fetch: fetchMock });
    const withWiki = await connect(createClaudeCodeMcpServer({ memory: fakeMemory(), knowledge }));
    expect((await withWiki.client.listTools()).tools.map((t) => t.name)).toEqual([
      "tdai_memory_search", "tdai_conversation_search", "tdai_scenario_read", "tdai_memory_capture",
      "tdai_wiki_list", "tdai_wiki_search", "tdai_wiki_pages", "tdai_wiki_read", "tdai_wiki_write",
    ]);
    await expect(withWiki.client.callTool({ name: "tdai_wiki_list", arguments: {} })).resolves.toMatchObject({
      structuredContent: { items: [{ wiki_id: "w1", name: "team" }] },
    });
    expect(fetchMock.mock.calls[0][0]).toBe("http://knowledge.test/v3/wiki/list");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ team_id: "t1", limit: 20 });
    await withWiki.close();

    const without = await connect(createClaudeCodeMcpServer({ memory: fakeMemory() }));
    expect((await without.client.listTools()).tools.map((t) => t.name)).toHaveLength(4);
    await without.close();
  });

  it("formats search results, reads scenes, and captures milestones through the v3 client", async () => {
    const memory = fakeMemory();
    const { client, close } = await connect(createClaudeCodeMcpServer({ memory, defaultSessionId: "claude-code:s1" }));

    const search = await client.callTool({ name: "tdai_memory_search", arguments: { query: "deploy", limit: 3, type: "episodic" } });
    expect(memory.searchAtomic).toHaveBeenCalledWith({ query: "deploy", limit: 3, type: "episodic" });
    expect((search.content as { text: string }[])[0].text).toContain("**[episodic]** (score: 0.800)");

    const conv = await client.callTool({ name: "tdai_conversation_search", arguments: { query: "tool_use", session_id: "s9" } });
    expect(memory.searchConversation).toHaveBeenCalledWith({ query: "tool_use", limit: 5, session_id: "s9" });
    expect((conv.content as { text: string }[])[0].text).toContain("[tool_use …]");

    await expect(client.callTool({ name: "tdai_scenario_read", arguments: { path: "scene/a.md" } })).resolves.toMatchObject({
      content: [{ type: "text", text: "# A" }],
    });

    await client.callTool({ name: "tdai_memory_capture", arguments: { note: "Ruling: tdai is an option." } });
    expect(memory.addConversation).toHaveBeenCalledWith({ session_id: "claude-code:s1", messages: [{ role: "assistant", content: "Ruling: tdai is an option." }] });
    await close();
  });

  it("knowledge client unwraps envelopes and surfaces non-zero codes", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { results: [1] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40401, message: "wiki not found", request_id: "r1" })))
      .mockResolvedValueOnce(new Response("down", { status: 503 }));
    const client = new KnowledgeServiceClient({ baseUrl: "http://k/", serviceId: "svc", apiKey: "key", teamId: "t", userId: "u", agentId: "a", fetch: fetchMock });
    await expect(client.post("/v3/wiki/search", { query: "x" })).resolves.toEqual({ results: [1] });
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ "Content-Type": "application/json", "x-tdai-service-id": "svc", Authorization: "Bearer key" });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ team_id: "t", user_id: "u", agent_id: "a", query: "x" });
    await expect(client.post("/v3/wiki/search", {})).rejects.toThrow("Knowledge /v3/wiki/search error 40401: wiki not found (r1)");
    await expect(client.post("/v3/wiki/list", {})).rejects.toThrow("returned HTTP 503");
  });
});
