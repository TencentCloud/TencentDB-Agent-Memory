/**
 * Wiki HTTP routes: ingest metadata is visible via list/get/raw ls+list.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { createDb } from "../db/client.js";
import { SqliteKnowledgeStore } from "../store/sqlite-store.js";
import { WikiService, type WikiWorker } from "../store/wiki-service.js";
import { createWikiRoutes } from "./wiki.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";

const SERVICE = "default";
const TEAM = "test-team-123";
const headers = { "Content-Type": "application/json", "x-tdai-service-id": SERVICE };

function stubMgr(): WikiSourceManager {
  return {
    register: () => ({}) as never,
    sync: () => ({}) as never,
    get: () => undefined,
    list: () => [],
    remove: () => undefined,
    search: () => ({ results: [], links: [], count: 0 }),
    graph: () => ({ nodes: [], edges: [], communities: [] }),
    readPage: () => null,
    getPages: () => [],
    init: () => ({}) as never,
    ingest: async () => [],
  };
}

async function post(app: Hono, path: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const res = await app.request(path, {
    method: "POST",
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { code: number; message?: string; data?: unknown };
  return { status: res.status, json };
}

describe("wiki routes metadata after ingest", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("exposes the wiki via list, get, raw/ls, and raw/list after ingest", async () => {
    const worker: WikiWorker = async () => ({ pageCount: 2 });
    const dataRoot = mkdtempSync(join(tmpdir(), "wiki-routes-"));
    dirs.push(dataRoot);
    const { db } = createDb({ path: ":memory:" });
    const store = new SqliteKnowledgeStore(db);
    const wikiService = new WikiService({ store, dataRoot, worker });
    const app = new Hono().route("/v3/wiki", createWikiRoutes({
      wikiService,
      wikiMgr: stubMgr(),
      publicBaseUrl: "http://localhost:8424/v3",
    }));

    const created = await post(app, "/v3/wiki/create", { team_id: TEAM, name: "Route Wiki" });
    expect(created.json.code).toBe(0);
    const wikiId = (created.json.data as { wiki_id: string }).wiki_id;

    const write = await post(app, "/v3/wiki/raw/write", {
      team_id: TEAM,
      wiki_id: wikiId,
      files: [
        { filename: "a.md", content: "# A\n" },
        { filename: "b.md", content: "# B\n" },
      ],
    });
    expect(write.json.code).toBe(0);

    const ingest = await post(app, "/v3/wiki/ingest", { wiki_id: wikiId });
    expect(ingest.json.code).toBe(0);
    await wikiService.onIdle(wikiId);

    const list = await post(app, "/v3/wiki/list", { team_id: TEAM });
    expect(list.json.code).toBe(0);
    const items = (list.json.data as { items: Array<{ wiki_id: string; status: string; page_count: number | null }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("ready");
    expect(items[0].page_count).toBe(2);

    const get = await post(app, "/v3/wiki/get", { wiki_id: wikiId });
    expect(get.json.code).toBe(0);
    expect((get.json.data as { status: string }).status).toBe("ready");

    const ls = await post(app, "/v3/wiki/raw/ls", { wiki_id: wikiId });
    expect(ls.status).toBe(200);
    expect(ls.json.code).toBe(0);
    expect((ls.json.data as { items: unknown[] }).items).toHaveLength(2);

    const alias = await post(app, "/v3/wiki/raw/list", { wiki_id: wikiId });
    expect(alias.status).toBe(200);
    expect(alias.json.code).toBe(0);
    expect((alias.json.data as { items: unknown[] }).items).toHaveLength(2);
  });
});
