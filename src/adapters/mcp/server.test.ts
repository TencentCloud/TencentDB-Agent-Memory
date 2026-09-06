import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryMcpServer } from "./server.js";

// Wiki tools read TDAI_* identity defaults from the environment; keep a
// developer shell that exports them from changing the asserted request bodies.
beforeEach(() => {
  for (const key of ["TDAI_SERVICE_ID", "TDAI_TEAM_ID", "TDAI_USER_ID", "TDAI_AGENT_ID", "TDAI_KNOWLEDGE_API_KEY", "TDAI_GATEWAY_API_KEY"]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
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
      "tdai_wiki_list",
      "tdai_wiki_search",
      "tdai_wiki_pages",
      "tdai_wiki_read",
      "tdai_wiki_write",
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

  it("calls wiki tools through MCP against the Knowledge Service", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [{ wiki_id: "wiki-1", name: "team" }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { results: [{ path: "wiki/deploy.md", score: 2 }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { items: [{ ref: "wiki/deploy.md", content: "# Deploy" }] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40401, message: "wiki not found" }), { status: 200 }));
    const server = createMemoryMcpServer({
      fetch: fetchMock,
      knowledge: { baseUrl: "http://knowledge.test", teamId: "team-1", serviceId: "svc" },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await expect(client.callTool({ name: "tdai_wiki_list", arguments: {} })).resolves.toMatchObject({
      structuredContent: { items: [{ wiki_id: "wiki-1", name: "team" }] },
    });

    await expect(client.callTool({
      name: "tdai_wiki_search",
      arguments: { wiki_id: "wiki-1", query: "deploy", limit: 5 },
    })).resolves.toMatchObject({
      content: [{ type: "text", text: JSON.stringify({ results: [{ path: "wiki/deploy.md", score: 2 }] }, null, 2) }],
      structuredContent: { results: [{ path: "wiki/deploy.md", score: 2 }] },
    });

    await expect(client.callTool({
      name: "tdai_wiki_read",
      arguments: { wiki_id: "wiki-1", refs: ["wiki/deploy.md"] },
    })).resolves.toMatchObject({
      structuredContent: { items: [{ ref: "wiki/deploy.md", content: "# Deploy" }] },
    });

    const failed = await client.callTool({
      name: "tdai_wiki_pages",
      arguments: { wiki_id: "missing" },
    });
    expect(failed.isError).toBe(true);
    expect(failed.content).toEqual([
      { type: "text", text: "Knowledge /v3/wiki/page/ls error 40401: wiki not found" },
    ]);

    const [, searchInit] = fetchMock.mock.calls[1];
    expect(fetchMock.mock.calls[1][0]).toBe("http://knowledge.test/v3/wiki/search");
    expect(searchInit?.headers).toEqual({ "Content-Type": "application/json", "x-tdai-service-id": "svc" });
    expect(JSON.parse(String(searchInit?.body))).toEqual({ team_id: "team-1", wiki_id: "wiki-1", query: "deploy", limit: 5 });

    await client.close();
    await server.close();
  });

  it("registers memory tools only when the Knowledge Service is disabled", async () => {
    const server = createMemoryMcpServer({ fetch: vi.fn<typeof fetch>(), knowledge: false });
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

    await client.close();
    await server.close();
  });
});