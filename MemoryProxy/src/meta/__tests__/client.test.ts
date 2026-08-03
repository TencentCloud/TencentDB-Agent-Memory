import { describe, expect, it, vi } from "vitest";

import { MetadataClient } from "../client.js";

describe("MetadataClient pagination", () => {
  it("aggregates successive pages with the requested offsets", async () => {
    const offsets: number[] = [];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { limit: number; offset: number };
      offsets.push(body.offset);
      const items = body.offset === 0
        ? Array.from({ length: 100 }, (_, i) => ({ team_id: `team-${i}`, name: `Team ${i}` }))
        : [{ team_id: "team-100", name: "Team 100" }];
      return new Response(JSON.stringify({
        code: 0,
        data: { items, total: 101, limit: body.limit, offset: body.offset },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new MetadataClient(
      {
        endpoint: "http://metadata.test",
        serviceToken: "token",
        timeoutMs: 1_000,
      },
      "instance-1",
      "user-key",
      fetcher as typeof fetch,
    );

    await expect(client.listTeams("user-1")).resolves.toHaveLength(101);
    expect(offsets).toEqual([0, 100]);
  });

  it("stops when a page is empty even if the reported total is stale", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (fetcher.mock.calls.length > 1) {
        throw new Error("unexpected request after empty page");
      }
      const body = JSON.parse(String(init?.body)) as { limit: number; offset: number };
      return new Response(JSON.stringify({
        code: 0,
        data: {
          items: [],
          total: 250,
          limit: body.limit,
          offset: body.offset,
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new MetadataClient(
      {
        endpoint: "http://metadata.test",
        serviceToken: "token",
        timeoutMs: 1_000,
      },
      "instance-1",
      "user-key",
      fetcher as typeof fetch,
    );

    await expect(client.listTeams("user-1")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
