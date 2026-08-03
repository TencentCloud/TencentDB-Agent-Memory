import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { WikiSourceManager } from "../engines/wiki/index.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { CodeGraphService, WikiService } from "../store/index.js";
import { createCodeGraphRoutes } from "./code-graph.js";
import { createWikiRoutes } from "./wiki.js";

const wikiList = vi.fn(() => []);
const wikiCount = vi.fn(() => 0);
const codeGraphList = vi.fn(() => []);
const codeGraphCount = vi.fn(() => 0);

const app = new Hono();
app.route(
  "/v3/wiki",
  createWikiRoutes({
    wikiService: {
      list: wikiList,
      count: wikiCount,
    } as unknown as WikiService,
    wikiMgr: {} as WikiSourceManager,
    publicBaseUrl: "",
  }),
);
app.route(
  "/v3/code-graph",
  createCodeGraphRoutes({
    cgService: {
      list: codeGraphList,
      count: codeGraphCount,
    } as unknown as CodeGraphService,
    instancePool: {} as CodeGraphInstancePool,
    publicBaseUrl: "",
  }),
);

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tdai-service-id": "instance-1",
    },
    body: JSON.stringify({ team_id: "team-1", ...body }),
  });
}

describe.each([
  ["wiki", "/v3/wiki/list", wikiList],
  ["code graph", "/v3/code-graph/list", codeGraphList],
] as const)("%s list pagination", (_resource, path, list) => {
  it.each([
    [{ limit: 0 }, "limit must be a positive integer"],
    [{ limit: -1 }, "limit must be a positive integer"],
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ limit: "10" }, "limit must be a positive integer"],
    [{ offset: -1 }, "offset must be a non-negative integer"],
    [{ offset: 1.5 }, "offset must be a non-negative integer"],
    [{ offset: "0" }, "offset must be a non-negative integer"],
  ])("rejects invalid pagination %#", async (pagination, message) => {
    vi.clearAllMocks();

    const response = await post(path, pagination);
    const envelope = await response.json();

    expect(response.status).toBe(400);
    expect(envelope).toMatchObject({ code: 400, message, data: null });
    expect(list).not.toHaveBeenCalled();
  });

  it("passes validated pagination to the store", async () => {
    vi.clearAllMocks();

    const response = await post(path, { limit: 25, offset: 50 });

    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      "instance-1",
      "team-1",
      expect.objectContaining({ limit: 25, offset: 50 }),
    );
  });
});
