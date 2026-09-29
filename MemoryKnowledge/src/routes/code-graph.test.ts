import { describe, expect, it, vi } from "vitest";

import { createCodeGraphRoutes } from "./code-graph.js";
import { createToolsRoutes } from "./tools.js";
import type { CodeGraphService } from "../store/code-graph-service.js";
import type { CodeGraphRow } from "../store/types.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { CodeGraphInstance } from "../engines/code/index.js";
import type { WikiService } from "../store/wiki-service.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";

const codeGraphId = "cg-12345678";
const headers = { "content-type": "application/json", "x-tdai-service-id": "svc-1" };

function rowWith(patch: Partial<CodeGraphRow> = {}): CodeGraphRow {
  return {
    code_graph_id: codeGraphId, service_id: "svc-1", team_id: "team-1",
    repo_name: "repo", repo_url: "https://example.com/repo.git", branch: "main",
    commit_hash: "last-good-commit", owner_user_id: null, user_id: null,
    agent_id: null, task_id: null, visibility: "team", status: "ready",
    internal_status: null, sync_error: null, stats_json: null, service_url: null,
    summary: null, auto_sync_probe_error: null, auto_sync_probe_at: null,
    version: 2, has_last_good: true, last_sync_at: "2026-09-25T00:00:00Z",
    created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-25T00:00:00Z",
    deleted_at: null, ...patch,
  };
}

function fixture(row: CodeGraphRow, options: { loaded?: boolean; lazyLoad?: boolean; paused?: boolean } = {}) {
  const execute = vi.fn(async () => ({ content: [{ text: "last-good index answer" }], isError: false }));
  const instance = { projectRoot: "/unused", cg: {}, handler: { execute } } as unknown as CodeGraphInstance;
  let currentInstance = options.loaded === false ? undefined : instance;
  const release = vi.fn();
  const acquire = vi.fn(() => options.paused || !currentInstance ? undefined : { instance: currentInstance, release });
  const loadIfMissing = vi.fn(async () => {
    if (options.lazyLoad) currentInstance = instance;
    return currentInstance;
  });
  const instancePool = {
    get: () => currentInstance,
    set: (_id: string, value: CodeGraphInstance) => { currentInstance = value; },
    delete: () => { currentInstance = undefined; },
    acquire, loadIfMissing,
  } as CodeGraphInstancePool;
  const cgService = {
    getById: () => row,
    get: () => row,
    dirFor: () => "/unused/svc-1/team-1/cg-12345678",
  } as unknown as CodeGraphService;
  return { cgService, instancePool, execute, acquire, release, loadIfMissing };
}

async function query(route: "direct" | "tools", deps: ReturnType<typeof fixture>): Promise<Response> {
  if (route === "direct") {
    const app = createCodeGraphRoutes({ ...deps, publicBaseUrl: "" });
    return app.request("/status", {
      method: "POST", headers, body: JSON.stringify({ code_graph_id: codeGraphId }),
    });
  }
  const app = createToolsRoutes({
    ...deps, wikiService: {} as WikiService, wikiMgr: {} as WikiSourceManager,
  });
  return app.request("/call", {
    method: "POST", headers,
    body: JSON.stringify({ knowledge_id: codeGraphId, tool_name: "status", params: {} }),
  });
}

describe.each(["direct", "tools"] as const)("CodeGraph %s query availability", (route) => {
  it.each([
    { name: "ready", patch: {}, stale: false },
    { name: "ready after failed refresh", patch: { sync_error: "Git unavailable" }, stale: true },
    { name: "pending refresh", patch: { status: "pending" }, stale: true },
    { name: "pending legacy refresh without a timestamp", patch: { status: "pending", last_sync_at: null }, stale: true },
    { name: "processing fetch", patch: { status: "processing", internal_status: "fetching" }, stale: true },
    { name: "processing index", patch: { status: "processing", internal_status: "indexing" }, stale: true },
    { name: "legacy refresh without a timestamp", patch: { status: "processing", last_sync_at: null }, stale: true },
  ] satisfies Array<{ name: string; patch: Partial<CodeGraphRow>; stale: boolean }>)
  ("serves the last-good index while $name", async ({ patch, stale }) => {
    const deps = fixture(rowWith(patch));
    const response = await query(route, deps);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.text).toBe("last-good index answer");
    expect(body.data.stale).toBe(stale ? true : undefined);
    if (stale) {
      expect(body.data.served_commit_hash).toBe("last-good-commit");
      expect(body.data.last_sync_at).toBe(patch.last_sync_at === null ? null : "2026-09-25T00:00:00Z");
    }
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.release).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "first build pending", patch: { status: "pending", has_last_good: false, last_sync_at: null }, errorCode: "CODE_GRAPH_INDEX_BUILDING", options: {} },
    { name: "first build with an unrelated timestamp", patch: { status: "pending", has_last_good: false }, errorCode: "CODE_GRAPH_INDEX_BUILDING", options: {} },
    { name: "first build processing", patch: { status: "processing", internal_status: "indexing", has_last_good: false, last_sync_at: null }, errorCode: "CODE_GRAPH_INDEX_BUILDING", options: {} },
    { name: "copying old index", patch: { status: "processing", internal_status: "copying" }, errorCode: "CODE_GRAPH_INDEX_SWITCHING", options: {} },
    { name: "promoting new index", patch: { status: "processing", internal_status: "promoting" }, errorCode: "CODE_GRAPH_INDEX_SWITCHING", options: {} },
    { name: "old instance missing", patch: { status: "processing", internal_status: "fetching" }, errorCode: "CODE_GRAPH_INDEX_UNAVAILABLE", options: { loaded: false } },
    { name: "pool paused", patch: { status: "processing", internal_status: "fetching" }, errorCode: "CODE_GRAPH_INDEX_UNAVAILABLE", options: { paused: true } },
  ] satisfies Array<{ name: string; patch: Partial<CodeGraphRow>; errorCode: string; options: Parameters<typeof fixture>[1] }>)
  ("returns retryable 503 while $name", async ({ patch, errorCode, options }) => {
    const deps = fixture(rowWith(patch), options);
    const response = await query(route, deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect((await response.json()).error_code).toBe(errorCode);
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.loadIfMissing).not.toHaveBeenCalled();
  });

  it.each([
    { name: "initial build failed", patch: { status: "failed", last_sync_at: null, commit_hash: null } },
    { name: "rollback failed despite old timestamp", patch: { status: "failed" } },
  ] satisfies Array<{ name: string; patch: Partial<CodeGraphRow> }>)
  ("returns a permanent machine code when $name", async ({ patch }) => {
    const deps = fixture(rowWith(patch));
    const response = await query(route, deps);
    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBeNull();
    const body = await response.json();
    expect(body.code).toBe(409);
    expect(body.error_code).toBe("CODE_GRAPH_INDEX_FAILED");
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("lazy-loads a ready index and releases its query lease", async () => {
    const deps = fixture(rowWith(), { loaded: false, lazyLoad: true });
    const response = await query(route, deps);
    expect(response.status).toBe(200);
    expect(deps.loadIfMissing).toHaveBeenCalledOnce();
    expect(deps.acquire).toHaveBeenCalledTimes(2);
    expect(deps.release).toHaveBeenCalledOnce();
  });

  it("returns retryable 503 if a ready index cannot be lazy-loaded", async () => {
    const deps = fixture(rowWith(), { loaded: false });
    const response = await query(route, deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect((await response.json()).error_code).toBe("CODE_GRAPH_INDEX_UNAVAILABLE");
    expect(deps.loadIfMissing).toHaveBeenCalledOnce();
  });

  it("does not lazy-load an asset deleted after the route read its row", async () => {
    const row = rowWith();
    const deps = fixture(row, { loaded: false, lazyLoad: true });
    deps.cgService.getById = vi.fn().mockReturnValueOnce(row).mockReturnValue(null);
    const response = await query(route, deps);
    expect(response.status).toBe(404);
    expect(deps.loadIfMissing).not.toHaveBeenCalled();
  });
});

describe("CodeGraph sync admission", () => {
  it("awaits an asynchronous CAS conflict and returns a machine code", async () => {
    const row = rowWith();
    const cgService = {
      getById: () => row,
      sync: async () => ({ kind: "conflict" as const }),
    } as unknown as CodeGraphService;
    const app = createCodeGraphRoutes({
      cgService, instancePool: {} as CodeGraphInstancePool, publicBaseUrl: "",
    });
    const response = await app.request("/sync", {
      method: "POST", headers, body: JSON.stringify({ code_graph_id: codeGraphId }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error_code).toBe("CODE_GRAPH_SYNC_CONFLICT");
  });

  it("preserves the busy response for an already running sync", async () => {
    const cgService = {
      getById: () => rowWith({ status: "processing", internal_status: "fetching" }),
      sync: async () => ({ kind: "busy" as const, status: "processing" as const, step: "fetching" }),
    } as unknown as CodeGraphService;
    const app = createCodeGraphRoutes({
      cgService, instancePool: {} as CodeGraphInstancePool, publicBaseUrl: "",
    });
    const response = await app.request("/sync", {
      method: "POST", headers, body: JSON.stringify({ code_graph_id: codeGraphId }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 409, message: "busy", data: { status: "processing", step: "fetching" },
    });
  });
});
