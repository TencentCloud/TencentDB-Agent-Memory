import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb } from "../db/client.js";
import { callbackTMC, generateWikiSummary } from "../callback.js";
import { evictWikiDb, recordSourceIngestResult, sha256, withWriteDb } from "../engines/wiki/index-db.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";
import { createServiceAuthMiddleware } from "../middleware/auth.js";
import { createWikiRoutes } from "../routes/wiki.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { WikiService, type WikiWorker } from "./wiki-service.js";

vi.mock("../callback.js", () => ({
  callbackTMC: vi.fn(),
  generateWikiSummary: vi.fn(),
}));

describe("wiki ingest metadata", () => {
  let root: string;
  let database: ReturnType<typeof createDb>;
  let store: SqliteKnowledgeStore;
  let service: WikiService;
  let wikiId: string;
  const warn = vi.fn();
  const serviceId = "test-service";
  const teamId = "test-team";

  function setup(worker: WikiWorker = async () => ({ pageCount: 7 })) {
    service = new WikiService({
      store, dataRoot: root, worker, logger: { warn },
      callbackConfig: {
        tmcCallbackUrl: "http://panel.invalid",
        resolveLlm: () => ({
          mode: "custom", protocol: "openai", provider: "test", apiKey: "test",
          model: "test", baseUrl: "http://llm.invalid", maxTokens: 100, timeoutMs: 100,
        }),
      },
    });
    wikiId = service.create({ service_id: serviceId, team_id: teamId, name: "Batch wiki" }).row.wiki_id;
  }

  function app() {
    const http = new Hono();
    http.use("/v3/*", createServiceAuthMiddleware({ serviceKey: "test-key" }, "/v3"));
    http.route("/v3/wiki", createWikiRoutes({
      wikiService: service, wikiMgr: {} as WikiSourceManager, publicBaseUrl: "http://ks.invalid/v3",
    }));
    return http;
  }

  function post(http: Hono, path: string, body: object, tenant = serviceId, authenticated = false) {
    return http.request(`/v3/wiki${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "x-tdai-service-id": tenant,
        ...(authenticated ? { Authorization: "Bearer test-key" } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(callbackTMC).mockResolvedValue(undefined);
    vi.mocked(generateWikiSummary).mockResolvedValue("Test summary");
    root = mkdtempSync(join(tmpdir(), "wiki-1232-"));
    database = createDb({ path: join(root, "knowledge.db") });
    store = new SqliteKnowledgeStore(database.db);
    setup();
  });

  afterEach(async () => {
    await service.onIdle();
    evictWikiDb(wikiId);
    database.raw.close();
    // root is exclusively owned by this fixture, created by mkdtempSync above.
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the committed result when the completion callback rejects", async () => {
    vi.mocked(callbackTMC).mockImplementation(async () => {
      expect(store.getWikiById(serviceId, wikiId)).toMatchObject({ status: "ready", page_count: 7 });
      throw new Error("callback unavailable");
    });
    service.ingest(serviceId, teamId, wikiId);
    await service.onIdle();
    expect(service.getById(serviceId, wikiId)).toMatchObject({
      status: "ready", page_count: 7, internal_status: null, sync_error: null,
    });
    expect(callbackTMC).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("callback unavailable"));
    database.raw.close();
    database = createDb({ path: join(root, "knowledge.db") });
    expect(new SqliteKnowledgeStore(database.db).getWikiById(serviceId, wikiId))
      .toMatchObject({ status: "ready", page_count: 7 });
  });

  it("retains ready metadata and sends the callback if summary generation fails", async () => {
    vi.mocked(generateWikiSummary).mockRejectedValue(new Error("summary unavailable"));
    service.ingest(serviceId, teamId, wikiId);
    await service.onIdle();
    expect(service.getById(serviceId, wikiId)).toMatchObject({ status: "ready", page_count: 7 });
    expect(callbackTMC).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }), expect.anything());
  });

  it("persists worker failure and supports a successful retry without duplicate rows", async () => {
    const worker = vi.fn<WikiWorker>()
      .mockRejectedValueOnce(new Error("source extraction failed"))
      .mockResolvedValueOnce({ pageCount: 9 });
    setup(worker);
    service.ingest(serviceId, teamId, wikiId);
    await service.onIdle();
    expect(service.getById(serviceId, wikiId)).toMatchObject({
      status: "failed", internal_status: null, sync_error: "source extraction failed",
    });
    service.ingest(serviceId, teamId, wikiId);
    await service.onIdle();
    expect(service.getById(serviceId, wikiId)).toMatchObject({
      status: "ready", page_count: 9, sync_error: null, internal_status: null,
    });
    expect(service.count(serviceId, teamId)).toBe(1);
  });

  it("does not recreate metadata when a wiki is deleted during ingestion", async () => {
    let complete!: () => void;
    setup(async () => {
      await new Promise<void>((resolve) => { complete = resolve; });
      return { pageCount: 7 };
    });
    service.ingest(serviceId, teamId, wikiId);
    expect(service.ingest(serviceId, teamId, wikiId).kind).toBe("busy");
    expect(service.delete(serviceId, teamId, wikiId)).toBe(true);
    complete();
    await service.onIdle();
    expect(service.getById(serviceId, wikiId)).toBeNull();
    expect(callbackTMC).not.toHaveBeenCalled();
  });

  it("clears the internal stage on restart and leaves completed metadata intact", async () => {
    service.ingest(serviceId, teamId, wikiId);
    await service.onIdle();
    const interrupted = store.createWiki({ service_id: serviceId, team_id: teamId, name: "Interrupted" }).row;
    store.updateWikiStatus(serviceId, interrupted.wiki_id, { status: "processing", internal_status: "ingesting" });
    expect(store.markInterruptedAsFailed()).toBe(1);
    expect(store.getWikiById(serviceId, interrupted.wiki_id)).toMatchObject({
      status: "failed", internal_status: null, sync_error: "interrupted by restart",
    });
    expect(store.getWikiById(serviceId, wikiId)).toMatchObject({ status: "ready", page_count: 7 });
  });

  it("recovers a failed metadata row from ingested index.db artifacts", async () => {
    const interrupted = store.createWiki({ service_id: serviceId, team_id: teamId, name: "Recoverable" }).row;
    const dir = service.dirFor(serviceId, teamId, interrupted.wiki_id);
    const files = service.rawWriteMany(serviceId, teamId, interrupted.wiki_id, [
      { filename: "source.md", content: "# Source\n" },
    ]);
    expect(files).toHaveLength(1);
    mkdirSync(join(dir, "wiki"), { recursive: true });
    writeFileSync(join(dir, "wiki", "page.md"), "---\ntitle: Page\n---\n# Page\n");
    withWriteDb(dir, (db) => recordSourceIngestResult(db, {
      filename: "source.md", sha256: sha256("# Source\n"), size: 9, ok: true,
    }));
    store.updateWikiStatus(serviceId, interrupted.wiki_id, { status: "failed", internal_status: "ingesting" });

    expect(service.recoverInterruptedFromDisk()).toBe(1);
    expect(service.getById(serviceId, interrupted.wiki_id)).toMatchObject({
      status: "ready", page_count: 1, internal_status: null, sync_error: null,
    });
  });

  it("serves raw/list with the same validation and tenant isolation as raw/ls", async () => {
    const http = app();
    const response = await post(http, "/raw/list", { wiki_id: wikiId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 0, data: { items: [] } });
    expect((await post(http, "/raw/list", { wiki_id: wikiId }, "another-service")).status).toBe(404);
    expect((await post(http, "/raw/list", {})).status).toBe(400);
    expect((await post(http, "/raw/write", { wiki_id: wikiId })).status).toBe(401);
  });

  it("persists metadata for 700 sources uploaded in 70 batches and exposes them through the API", async () => {
    // Replace only the paid LLM step; exercise real HTTP routes, files and SQLite databases.
    setup(async ({ dir, setInternalStatus }) => {
      setInternalStatus("ingesting");
      const sources = service.rawLs(serviceId, teamId, wikiId)!;
      mkdirSync(join(dir, "wiki"), { recursive: true });
      withWriteDb(dir, (db) => {
        for (const source of sources) {
          const content = readFileSync(join(dir, "raw", "sources", source.filename), "utf8");
          writeFileSync(join(dir, "wiki", source.filename), content);
          recordSourceIngestResult(db, {
            filename: source.filename, sha256: sha256(content), size: source.size, ok: true,
          });
        }
      });
      return { pageCount: sources.length };
    });
    const http = app();
    for (let offset = 0; offset < 700; offset += 10) {
      const files = Array.from({ length: 10 }, (_, i) => ({
        filename: `doc-${offset + i}.md`, content: `# Document ${offset + i}\nBatch fixture.\n`,
      }));
      const response = await post(http, "/raw/write", { wiki_id: wikiId, team_id: teamId, files }, serviceId, true);
      expect(response.status).toBe(200);
    }
    expect((await post(http, "/ingest", { wiki_id: wikiId }, serviceId, true)).status).toBe(202);
    await service.onIdle();
    const details = await (await post(http, "/get", { wiki_id: wikiId })).json();
    expect(details.data).toMatchObject({ status: "ready", page_count: 700, internal_status: null, sync_error: null });
    const listing = await (await post(http, "/list", { team_id: teamId })).json();
    expect(listing.data.items).toHaveLength(1);
    expect(listing.data.items[0]).toMatchObject({ wiki_id: wikiId, page_count: 700 });
    for (const path of ["/raw/ls", "/raw/list"]) {
      const response = await post(http, path, { wiki_id: wikiId });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.items).toHaveLength(700);
      expect(body.data.items.every((item: { status: string }) => item.status === "ingested")).toBe(true);
    }
  }, 30_000);
});
