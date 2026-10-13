import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolsRoutes, type ToolsRouteDeps } from "../src/routes/tools.js";
import { createCodeGraphRoutes, type CodeGraphRouteDeps } from "../src/routes/code-graph.js";
import { createServiceAuthMiddleware } from "../src/middleware/auth.js";
import { executeTool, type CodeGraphInstance } from "../src/engines/code/bridge.js";

// Use the actual Hono route, auth, validator and bridge. Only resource persistence
// and the native SDK handle are synthetic; this is not a native engine exploit.
describe("CodeGraph tool isolation", () => {
  let root: string;
  let app: Hono;
  let status: string;
  let loaded: boolean;
  let foreign: boolean;
  let handler: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let load: ReturnType<typeof vi.fn>;
  let instance: CodeGraphInstance;
  const id = "cg-12345678";
  const key = "synthetic-isolation-key";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tool-isolation-"));
    status = "ready";
    loaded = true;
    foreign = false;
    handler = vi.fn(async () => ({ content: [{ text: "synthetic-result" }], isError: false }));
    instance = { projectRoot: root, handler: { execute: handler }, cg: {} } as unknown as CodeGraphInstance;
    get = vi.fn(() => loaded ? instance : undefined);
    load = vi.fn(async () => undefined);
    const cgService = {
      getById: vi.fn((service: string, resource: string) => !foreign && service === "owned-service" && resource === id
        ? { code_graph_id: id, team_id: "owned-team", status } : undefined),
      dirFor: vi.fn(() => root),
    };
    const instancePool = { get, loadIfMissing: load };
    app = new Hono();
    app.use("/v3/*", createServiceAuthMiddleware({ serviceKey: key }, "/v3"));
    app.route("/v3/tools", createToolsRoutes({ cgService, instancePool, wikiService: {}, wikiMgr: {} } as unknown as ToolsRouteDeps));
    app.route("/v3/code-graph", createCodeGraphRoutes({ cgService, instancePool, publicBaseUrl: "" } as unknown as CodeGraphRouteDeps));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function call(params: unknown, tool = "search", token = key) {
    return app.request("/v3/tools/call", { method: "POST", headers: {
      "content-type": "application/json", "x-tdai-service-id": "owned-service", authorization: `Bearer ${token}`,
    }, body: JSON.stringify({ knowledge_id: id, tool_name: tool, params }) });
  }

  it.each([
    { query: "x", projectPath: "/synthetic-other-index" },
    { query: "x", code_graph_id: "cg-87654321" },
    { query: "x", arbitrarySDKControl: true },
    { query: 12 }, { query: "x", limit: 101 }, { query: "x", limit: 1.5 },
    { query: "x", kind: "unsupported" }, [],
  ])("rejects unsafe/invalid arguments before pool or SDK access: %j", async (params) => {
    expect((await call(params)).status).toBe(400);
    expect(get).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it("forwards declared query/defaults to the selected owned handle", async () => {
    const response = await call({ query: "synthetic-query" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { text: "synthetic-result", isError: false } });
    expect(get).toHaveBeenCalledWith(id);
    expect(handler).toHaveBeenCalledWith("codegraph_search", { query: "synthetic-query", limit: 10 });
  });
  it("preserves explicit supported parameters", async () => {
    expect((await call({ symbol: "run", includeCode: true, file: "src/main.ts", line: 3 }, "node")).status).toBe(200);
    expect(handler).toHaveBeenCalledWith("codegraph_node", { symbol: "run", includeCode: true, file: "src/main.ts", line: 3 });
  });
  it("requires authentication before resource loading", async () => {
    expect((await call({ query: "x" }, "search", "wrong-synthetic-key")).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
  it("keeps foreign resource lookups unavailable", async () => {
    foreign = true;
    expect((await call({ query: "x" })).status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });
  it("preserves not-ready and missing-instance behavior", async () => {
    status = "pending";
    expect((await call({ query: "x" })).status).toBe(200);
    expect(get).not.toHaveBeenCalled();
    status = "ready"; loaded = false;
    expect((await call({ query: "x" })).status).toBe(503);
    expect(load).toHaveBeenCalledWith(id, root);
    expect(handler).not.toHaveBeenCalled();
  });
  it("applies validation to the dedicated endpoint before pool loading", async () => {
    const response = await app.request("/v3/code-graph/search", { method: "POST", headers: {
      "content-type": "application/json", "x-tdai-service-id": "owned-service", authorization: `Bearer ${key}`,
    }, body: JSON.stringify({ code_graph_id: id, query: "x", projectPath: "/synthetic-other-index" }) });
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
  it("rejects direct SDK project overrides before invoking the handler", async () => {
    await expect(executeTool(instance, "codegraph_search", { query: "x", projectPath: root })).rejects.toThrow("unexpected field: projectPath");
    expect(handler).not.toHaveBeenCalled();
    await expect(executeTool(instance, "codegraph_status", {})).resolves.toEqual({ text: "synthetic-result", isError: false });
    expect(handler).toHaveBeenCalledWith("codegraph_status", {});
  });
});
