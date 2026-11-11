import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDb } from "../db/client.js";
import { SqliteKnowledgeStore, WikiService, CodeGraphService } from "../store/index.js";
import { createWikiRoutes, type WikiRouteDeps } from "./wiki.js";
import { createCodeGraphRoutes, type CodeGraphRouteDeps } from "./code-graph.js";

const SERVICE_ID = "service-a";
const TEAM_ID = "team-a";
const OLD_BASE_URL = "http://host.docker.internal:8424/v3";
const NEW_BASE_URL = "http://127.0.0.1:8424/v3";

interface WikiCreateResponse {
  data: {
    wiki_id: string;
    service_url: string | null;
  };
}

interface CodeGraphCreateResponse {
  data: {
    code_graph_id: string;
    service_url: string | null;
  };
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()?.();
  }
});

function createServices() {
  const dataRoot = mkdtempSync(join(tmpdir(), "knowledge-service-url-"));
  const { db, raw } = createDb({ path: ":memory:" });
  const store = new SqliteKnowledgeStore(db);
  const wikiService = new WikiService({
    store,
    dataRoot: join(dataRoot, "wiki"),
    worker: async () => ({ pageCount: 0 }),
  });
  const cgService = new CodeGraphService({
    store,
    dataRoot: join(dataRoot, "code-graph"),
    worker: async () => ({}),
  });

  cleanupTasks.push(async () => {
    await cgService.onIdle();
    raw.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  return { wikiService, cgService };
}

function wikiRoutes(wikiService: WikiService, publicBaseUrl: string) {
  return createWikiRoutes({
    wikiService,
    wikiMgr: {} as WikiRouteDeps["wikiMgr"],
    publicBaseUrl,
  });
}

function codeGraphRoutes(cgService: CodeGraphService, publicBaseUrl: string) {
  const instancePool: CodeGraphRouteDeps["instancePool"] = {
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  };
  return createCodeGraphRoutes({ cgService, instancePool, publicBaseUrl });
}

function postCreate(app: { request: (input: Request) => Response | Promise<Response> }, body: object) {
  return app.request(new Request("http://localhost/create", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tdai-service-id": SERVICE_ID,
    },
    body: JSON.stringify(body),
  }));
}

describe("knowledge service_url refresh", () => {
  it("refreshes an existing wiki when the public base URL changes", async () => {
    const { wikiService } = createServices();
    const body = { team_id: TEAM_ID, name: "team-docs" };

    const created = await postCreate(wikiRoutes(wikiService, OLD_BASE_URL), body);
    const createdPayload = await created.json() as WikiCreateResponse;

    expect(created.status).toBe(201);
    expect(createdPayload.data.service_url).toBe(OLD_BASE_URL);

    const refreshed = await postCreate(wikiRoutes(wikiService, NEW_BASE_URL), body);
    const refreshedPayload = await refreshed.json() as WikiCreateResponse;

    expect(refreshed.status).toBe(200);
    expect(refreshedPayload.data.wiki_id).toBe(createdPayload.data.wiki_id);
    expect(refreshedPayload.data.service_url).toBe(NEW_BASE_URL);
  });

  it("refreshes an existing code graph when the public base URL changes", async () => {
    const { cgService } = createServices();
    const body = {
      team_id: TEAM_ID,
      repo_url: "https://example.com/team/repo.git",
      branch: "main",
    };

    const created = await postCreate(codeGraphRoutes(cgService, OLD_BASE_URL), body);
    const createdPayload = await created.json() as CodeGraphCreateResponse;

    expect(created.status).toBe(201);
    expect(createdPayload.data.service_url).toBe(OLD_BASE_URL);

    const refreshed = await postCreate(codeGraphRoutes(cgService, NEW_BASE_URL), body);
    const refreshedPayload = await refreshed.json() as CodeGraphCreateResponse;

    expect(refreshed.status).toBe(200);
    expect(refreshedPayload.data.code_graph_id).toBe(createdPayload.data.code_graph_id);
    expect(refreshedPayload.data.service_url).toBe(NEW_BASE_URL);
  });
});
