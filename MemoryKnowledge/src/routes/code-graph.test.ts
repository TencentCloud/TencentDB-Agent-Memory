import { describe, expect, it } from "vitest";

import { createCodeGraphRoutes } from "./code-graph.js";
import { createToolsRoutes } from "./tools.js";
import type { CodeGraphService } from "../store/code-graph-service.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { WikiService } from "../store/wiki-service.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";

describe("CodeGraph query without a usable index", () => {
  it("returns an unavailable error through direct and tools/call routes", async () => {
    const cgService = {
      getById: () => ({ code_graph_id: "cg-12345678", team_id: "team-1", status: "failed" }),
    } as unknown as CodeGraphService;
    const instancePool = { get: () => undefined, set: () => {}, delete: () => {} } as CodeGraphInstancePool;

    const direct = createCodeGraphRoutes({ cgService, instancePool, publicBaseUrl: "" });
    const directResponse = await direct.request("/status", {
      method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "svc-1" },
      body: JSON.stringify({ code_graph_id: "cg-12345678" }),
    });
    expect(directResponse.status).toBe(503);
    expect((await directResponse.json()).code).toBe(503);

    const tools = createToolsRoutes({
      cgService, instancePool,
      wikiService: {} as WikiService,
      wikiMgr: {} as WikiSourceManager,
    });
    const toolResponse = await tools.request("/call", {
      method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "svc-1" },
      body: JSON.stringify({ knowledge_id: "cg-12345678", tool_name: "status", params: {} }),
    });
    expect(toolResponse.status).toBe(503);
    expect((await toolResponse.json()).code).toBe(503);
  });
});
