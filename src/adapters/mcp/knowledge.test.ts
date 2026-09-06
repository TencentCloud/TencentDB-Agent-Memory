import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKnowledgeTools, KnowledgeServiceClient } from "./knowledge.js";

// The client reads TDAI_* defaults from the environment; a developer shell that
// exports them must not change what these tests assert.
const TDAI_ENV_KEYS = [
  "TDAI_KNOWLEDGE_URL",
  "TDAI_KNOWLEDGE_API_KEY",
  "TDAI_GATEWAY_API_KEY",
  "TDAI_KNOWLEDGE_TIMEOUT_MS",
  "TDAI_SERVICE_ID",
  "TDAI_TEAM_ID",
  "TDAI_USER_ID",
  "TDAI_AGENT_ID",
];

beforeEach(() => {
  for (const key of TDAI_ENV_KEYS) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("KnowledgeServiceClient", () => {
  it("sends identity in the body and the service id in a header", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ code: 0, message: "ok", data: { items: [] } }),
    );
    const client = new KnowledgeServiceClient({
      fetch: fetchMock,
      baseUrl: "http://knowledge.test/",
      serviceId: "svc",
      teamId: "team-1",
      userId: "usr-1",
      agentId: "agt-1",
      apiKey: "secret",
    });

    await expect(client.post("/v3/wiki/list", { limit: 5 })).resolves.toEqual({ items: [] });

    expect(fetchMock.mock.calls[0][0]).toBe("http://knowledge.test/v3/wiki/list");
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      "Content-Type": "application/json",
      "x-tdai-service-id": "svc",
      Authorization: "Bearer secret",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      team_id: "team-1",
      user_id: "usr-1",
      agent_id: "agt-1",
      limit: 5,
    });
  });

  it("omits identity fields and auth that are not configured", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ code: 0, data: null }));
    const client = new KnowledgeServiceClient({ fetch: fetchMock, teamId: "team-1", serviceId: "default" });

    await expect(client.post("/v3/wiki/list", {})).resolves.toBeNull();

    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
      "Content-Type": "application/json",
      "x-tdai-service-id": "default",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ team_id: "team-1" });
  });

  it("returns bodies that are not wrapped in an envelope as-is", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: ["a"] }));
    const client = new KnowledgeServiceClient({ fetch: fetchMock });

    await expect(client.post("/v3/wiki/search", { query: "x" })).resolves.toEqual({ results: ["a"] });
  });

  it("rejects envelopes with a non-zero code", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ code: 40401, message: "wiki not found", request_id: "req-1" }),
    );
    const client = new KnowledgeServiceClient({ fetch: fetchMock });

    await expect(client.post("/v3/wiki/search", { query: "x" }))
      .rejects.toThrow("Knowledge /v3/wiki/search error 40401: wiki not found (req-1)");
  });

  it("rejects non-success HTTP responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "down" }, 503));
    const client = new KnowledgeServiceClient({ fetch: fetchMock });

    await expect(client.post("/v3/wiki/list", {})).rejects.toThrow("Knowledge /v3/wiki/list returned HTTP 503");
  });
});

describe("createKnowledgeTools", () => {
  it("maps every wiki operation to its Knowledge Service endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [{ wiki_id: "wiki-1", name: "team" }] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { results: [{ path: "wiki/a.md", score: 1 }] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: ["wiki/a.md"] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { items: [{ ref: "wiki/a.md", content: "# A" }] } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { written: 1 } }));
    const tools = createKnowledgeTools({ fetch: fetchMock, teamId: "team-1" });

    await expect(tools.listWikis({ limit: 500 })).resolves.toEqual({ items: [{ wiki_id: "wiki-1", name: "team" }] });
    await expect(tools.searchWiki({ wikiId: "wiki-1", query: "deploy" })).resolves.toEqual({
      results: [{ path: "wiki/a.md", score: 1 }],
    });
    await expect(tools.listWikiPages({ wikiId: "wiki-1", limit: 0 })).resolves.toEqual({ items: ["wiki/a.md"] });
    await expect(tools.readWikiPages({ wikiId: "wiki-1", refs: ["wiki/a.md"] })).resolves.toEqual({
      items: [{ ref: "wiki/a.md", content: "# A" }],
    });
    await expect(tools.writeWikiPages({ wikiId: "wiki-1", pages: [{ ref: "wiki/a.md", content: "# A2" }] }))
      .resolves.toEqual({ written: 1 });

    const calls = fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))]);
    expect(calls).toEqual([
      ["http://127.0.0.1:8424/v3/wiki/list", { team_id: "team-1", limit: 100 }],
      ["http://127.0.0.1:8424/v3/wiki/search", { team_id: "team-1", wiki_id: "wiki-1", query: "deploy", limit: 20 }],
      ["http://127.0.0.1:8424/v3/wiki/page/ls", { team_id: "team-1", wiki_id: "wiki-1", limit: 1 }],
      ["http://127.0.0.1:8424/v3/wiki/page/read", { team_id: "team-1", wiki_id: "wiki-1", refs: ["wiki/a.md"] }],
      [
        "http://127.0.0.1:8424/v3/wiki/page/write",
        { team_id: "team-1", wiki_id: "wiki-1", pages: [{ ref: "wiki/a.md", content: "# A2" }] },
      ],
    ]);
  });

  it("refuses oversized read and write batches before calling the service", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const tools = createKnowledgeTools({ fetch: fetchMock });
    const refs = Array.from({ length: 21 }, (_, index) => `wiki/${index}.md`);

    await expect(tools.readWikiPages({ wikiId: "wiki-1", refs })).rejects.toThrow("max is 20");
    await expect(tools.writeWikiPages({
      wikiId: "wiki-1",
      pages: refs.map((ref) => ({ ref, content: "x" })),
    })).rejects.toThrow("max is 20");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
