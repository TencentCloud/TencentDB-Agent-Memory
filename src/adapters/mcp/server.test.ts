import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryMcpServer } from "./server.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createMemoryMcpServer", () => {
  it("lists memory tools and calls every tool through MCP", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ context: "Remember concise answers.", strategy: "hybrid", memory_count: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ flushed: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: "L1 result", total: 1, strategy: "vector" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: "L0 result", total: 2 }), { status: 200 }));
    const server = createMemoryMcpServer({ fetch: fetchMock });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "tdai_memory_recall",
      "tdai_memory_capture",
      "tdai_session_end",
      "tdai_memory_search",
      "tdai_conversation_search",
    ]);

    const result = await client.callTool({
      name: "tdai_memory_recall",
      arguments: { query: "response style", session_key: "codex:session-1" },
    });

    expect(result.content).toEqual([
      { type: "text", text: "Remember concise answers." },
    ]);
    expect(result.structuredContent).toEqual({
      context: "Remember concise answers.",
      strategy: "hybrid",
      memory_count: 1,
    });

    await expect(client.callTool({
      name: "tdai_memory_capture",
      arguments: {
        user_content: "Implement it",
        assistant_content: "Implemented it",
        session_key: "codex:session-1",
        session_id: "session-1",
      },
    })).resolves.toMatchObject({
      structuredContent: { l0_recorded: 2, scheduler_notified: true },
    });

    await expect(client.callTool({
      name: "tdai_session_end",
      arguments: { session_key: "codex:session-1" },
    })).resolves.toMatchObject({
      structuredContent: { flushed: true },
    });

    await expect(client.callTool({
      name: "tdai_memory_search",
      arguments: { query: "preference", limit: 3, type: "persona", scene: "work" },
    })).resolves.toMatchObject({
      content: [{ type: "text", text: "L1 result" }],
      structuredContent: { results: "L1 result", total: 1, strategy: "vector" },
    });

    await expect(client.callTool({
      name: "tdai_conversation_search",
      arguments: { query: "exact phrase", limit: 4, session_key: "codex:session-1" },
    })).resolves.toMatchObject({
      content: [{ type: "text", text: "L0 result" }],
      structuredContent: { results: "L0 result", total: 2 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);

    await client.close();
    await server.close();
  });
});