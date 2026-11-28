import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDb } from "../../db/client.js";
import { createWikiSourceManager } from "../../engines/wiki/manager.js";
import { SqliteKnowledgeStore, WikiService } from "../../store/index.js";
import { createWikiRoutes } from "../wiki.js";

it("reports a failed index refresh without losing the last searchable version", async () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-page-write-index-"));
  const { db, raw } = createDb({ path: ":memory:" });
  const store = new SqliteKnowledgeStore(db);
  const wikiService = new WikiService({ store, dataRoot: root, worker: async () => {} });
  const wikiMgr = createWikiSourceManager(join(root, "state"));
  const serviceId = "helpdesk";
  const teamId = "ops";
  const { row } = wikiService.create({ service_id: serviceId, team_id: teamId, name: "Backup" });
  const wikiId = row.wiki_id;
  const path = wikiService.dirFor(serviceId, teamId, wikiId);
  const app = createWikiRoutes({ wikiService, wikiMgr, publicBaseUrl: "" });
  const post = (route: string, body: object) => app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": serviceId },
    body: JSON.stringify({ wiki_id: wikiId, team_id: teamId, ...body }),
  });
  const page = (version: number) => ({
    ref: "entities/backup.md",
    content: "---\ntitle: 백업 장애 " + version + "\ntype: entity\n---\n복구 절차\n",
  });
  const search = async () => {
    const response = await post("/search", { query: "백업", hop: 0 });
    expect(response.status).toBe(200);
    return (await response.json()).data.results.map((result: { title: string }) => result.title);
  };

  try {
    store.updateWikiStatus(serviceId, wikiId, { status: "ready" });
    const unregistered = await post("/page/write", { pages: [page(1)] });
    expect(unregistered.status).toBe(200);
    expect(await unregistered.json()).toMatchObject({
      code: 0,
      data: { items: [{ ref: page(1).ref }], index_status: "error" },
    });

    wikiMgr.register({ name: wikiId, path });
    expect(await search()).toEqual(["백업 장애 1"]);

    const index = new Database(join(path, "index.db"));
    try {
      index.exec("CREATE TRIGGER reject_refresh BEFORE INSERT ON page_meta BEGIN SELECT RAISE(ABORT, 'test index failure'); END");
      const failed = await post("/page/write", { pages: [page(2)] });
      expect(failed.status).toBe(200);
      const response = await failed.json();
      expect(response.code).toBe(0);
      expect(response.data.items[0].ref).toBe(page(2).ref);
      expect(wikiMgr.get(wikiId)?.status).toBe("error");
      expect(await search()).toEqual(["백업 장애 1"]);
      const savedPage = await post("/page/read", { refs: [page(2).ref] });
      expect((await savedPage.json()).data.items[0].content).toContain("title: 백업 장애 2");

      index.exec("DROP TRIGGER reject_refresh");
      const retried = await post("/page/write", { pages: [page(2)] });
      expect(retried.status).toBe(200);
      expect((await retried.json()).data).not.toHaveProperty("index_status");
      expect(await search()).toEqual(["백업 장애 2"]);
      expect(response.data.index_status).toBe("error");
    } finally {
      index.close();
    }
  } finally {
    wikiMgr.remove(wikiId);
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});
