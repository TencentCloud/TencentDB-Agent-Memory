import { describe, expect, it, vi } from "vitest";

import { CoreKnowledgeClient } from "../knowledge/core-client.js";

describe("CoreKnowledgeClient.listKnowledge", () => {
  it("aggregates every page instead of stopping at 200 resources", async () => {
    const allItems = Array.from({ length: 201 }, (_, index) => ({
      knowledge_id: `knowledge-${index}`,
      asset_type: "llm_wiki",
      name: `Knowledge ${index}`,
      service_url: "http://knowledge.example.com/v3",
      summary: null,
      team_id: "team-test",
      user_id: null,
      created_at: "2026-10-22T00:00:00.000Z",
      updated_at: "2026-10-22T00:00:00.000Z",
    }));
    const offsets: number[] = [];
    const fetcher = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        pagination?: { limit?: number; offset?: number };
      };
      const limit = body.pagination?.limit ?? 20;
      const offset = body.pagination?.offset ?? 0;
      offsets.push(offset);
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        data: {
          items: allItems.slice(offset, offset + limit),
          total: allItems.length,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new CoreKnowledgeClient({
      endpoint: "http://knowledge.example.com/v3",
      serviceToken: "service-token",
      serviceId: "space-test",
      timeoutMs: 1_000,
    }, fetcher as unknown as typeof fetch);

    const result = await client.listKnowledge("team-test");

    expect(result).toHaveLength(201);
    expect(offsets).toEqual([0, 200]);
  });
});

describe("CoreKnowledgeClient.listAgentKnowledgeIds", () => {
  it("paginates fixed knowledge bindings instead of using the default limit of 20", async () => {
    const allItems = Array.from({ length: 101 }, (_, index) => ({
      asset_id: `knowledge-${index}`,
      asset_type: "llm_wiki",
      status: "active",
    }));
    const requests: Array<{ limit: number; offset: number }> = [];
    const fetcher = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        limit?: number;
        offset?: number;
      };
      const limit = body.limit ?? 20;
      const offset = body.offset ?? 0;
      requests.push({ limit, offset });
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        data: {
          items: allItems.slice(offset, offset + limit),
          total: allItems.length,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new CoreKnowledgeClient({
      endpoint: "http://knowledge.example.com/v3",
      serviceToken: "service-token",
      serviceId: "space-test",
      timeoutMs: 1_000,
    }, fetcher as unknown as typeof fetch);

    const result = await client.listAgentKnowledgeIds("agent-test", "user-key");

    expect(result).toHaveLength(101);
    expect(requests).toEqual([
      { limit: 100, offset: 0 },
      { limit: 100, offset: 100 },
    ]);
  });
});

describe("CoreKnowledgeClient.listKnowledgeByIds", () => {
  it("batches detail lookups to the API limit of 200 ids", async () => {
    const ids = Array.from({ length: 201 }, (_, index) => `knowledge-${index}`);
    const batchSizes: number[] = [];
    const fetcher = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const body = JSON.parse(String(init?.body)) as { knowledge_ids?: string[] };
      const requested = body.knowledge_ids ?? [];
      batchSizes.push(requested.length);
      if (requested.length > 200) {
        return new Response(JSON.stringify({
          code: 400,
          message: "knowledge_ids: too many items",
        }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        code: 0,
        message: "ok",
        data: {
          items: requested.map((id) => ({
            knowledge_id: id,
            asset_type: "llm_wiki",
            name: id,
            service_url: "http://knowledge.example.com/v3",
            summary: null,
            team_id: "team-test",
            user_id: null,
            created_at: "2026-10-22T00:00:00.000Z",
            updated_at: "2026-10-22T00:00:00.000Z",
          })),
          total: requested.length,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new CoreKnowledgeClient({
      endpoint: "http://knowledge.example.com/v3",
      serviceToken: "service-token",
      serviceId: "space-test",
      timeoutMs: 1_000,
    }, fetcher as unknown as typeof fetch);

    const result = await client.listKnowledgeByIds("team-test", ids);

    expect(result).toHaveLength(201);
    expect(batchSizes).toEqual([200, 1]);
  });
});
