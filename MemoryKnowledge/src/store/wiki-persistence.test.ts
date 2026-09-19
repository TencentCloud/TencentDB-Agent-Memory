import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDb } from "../db/client.js";
import type { ApiResponseEnvelope, WikiDetail } from "../api-helpers.js";
import { callbackTMC, generateWikiSummary } from "../callback.js";
import {
  evictWikiDb, getReadDb, listSources, recordSourceIngestResult, withWriteDb,
} from "../engines/wiki/index-db.js";
import { createWikiSourceManager } from "../engines/wiki/manager.js";
import { createWikiRoutes } from "../routes/wiki.js";
import { createServiceAuthMiddleware } from "../middleware/auth.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { WikiService, type RawFileEntry, type WikiWorker } from "./wiki-service.js";

// Only external LLM/notification calls are replaced; files, SQLite and routes are real.
vi.mock("../callback.js", () => ({
  callbackTMC: vi.fn(async () => {}),
  generateWikiSummary: vi.fn(async () => ""),
}));

async function readData<T>(response: Response): Promise<T> {
  const envelope = await response.json() as ApiResponseEnvelope<T>;
  expect(envelope.code).toBe(0);
  expect(envelope.data).not.toBeNull();
  return envelope.data!;
}

describe("wiki metadata persistence (#1232)", () => {
  let root: string;
  let database: ReturnType<typeof createDb>;
  let store: SqliteKnowledgeStore;
  let service: WikiService;
  let wikiId: string;
  let dir: string;

  function makeService(worker: WikiWorker = async () => ({ pageCount: 3 })) {
    return new WikiService({
      store, dataRoot: root, worker,
      callbackConfig: {
        tmcCallbackUrl: "http://panel.invalid",
        resolveLlm: () => ({
          mode: "custom", protocol: "openai", provider: "openai", apiKey: "test",
          baseUrl: "http://llm.invalid", model: "test", maxTokens: 1024, timeoutMs: 1000,
        }),
      },
    });
  }

  function reopen() {
    database.raw.close();
    database = createDb({ path: join(root, "knowledge.db") });
    store = new SqliteKnowledgeStore(database.db);
    service = makeService();
  }

  function rejectSourceInsert() {
    withWriteDb(dir, (db) => db.exec(`
      CREATE TRIGGER reject_source BEFORE INSERT ON source
      WHEN NEW.filename = 'reject.md'
      BEGIN SELECT RAISE(ABORT, 'source metadata unavailable'); END;
    `));
  }

  beforeEach(() => {
    vi.resetAllMocks();
    root = mkdtempSync(join(tmpdir(), "wiki-persistence-"));
    database = createDb({ path: join(root, "knowledge.db") });
    store = new SqliteKnowledgeStore(database.db);
    service = makeService();
    wikiId = service.create({ service_id: "default", team_id: "team", name: "Test wiki" }).row.wiki_id;
    dir = service.dirFor("default", "team", wikiId);
  });

  afterEach(async () => {
    await service.onIdle();
    vi.restoreAllMocks();
    evictWikiDb(wikiId);
    database.raw.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a single upload when source metadata cannot be committed", () => {
    rejectSourceInsert();
    expect(() => service.rawWrite("default", "team", wikiId, "reject.md", "new"))
      .toThrow("source metadata unavailable");
    expect(readdirSync(join(dir, "raw", "sources"))).toEqual([]);
    expect(service.rawLs("default", "team", wikiId)).toEqual([]);
  });

  it("rolls back overwritten and new files together with a failed metadata batch, then retries", () => {
    service.rawWrite("default", "team", wikiId, "old.md", "original");
    const before = service.rawLs("default", "team", wikiId);
    rejectSourceInsert();
    const files = [
      { filename: "old.md", content: "replacement" },
      { filename: "new.md", content: "new" },
      { filename: "reject.md", content: "rejected" },
    ];
    expect(() => service.rawWriteMany("default", "team", wikiId, files))
      .toThrow("source metadata unavailable");
    expect(readFileSync(join(dir, "raw", "sources", "old.md"), "utf8")).toBe("original");
    expect(readdirSync(join(dir, "raw", "sources"))).toEqual(["old.md"]);
    expect(service.rawLs("default", "team", wikiId)).toEqual(before);

    withWriteDb(dir, (db) => db.exec("DROP TRIGGER reject_source"));
    expect(service.rawWriteMany("default", "team", wikiId, files)).toHaveLength(3);
    const committed = service.rawLs("default", "team", wikiId);
    service.rawWriteMany("default", "team", wikiId, files);
    expect(service.rawLs("default", "team", wikiId)).toEqual(committed);
  });

  it("keeps committed ready metadata when the notification rejects", async () => {
    vi.mocked(callbackTMC).mockRejectedValue(new Error("notification unavailable"));
    service.ingest("default", "team", wikiId);
    await service.onIdle();
    reopen();
    expect(service.get("default", "team", wikiId)).toMatchObject({
      status: "ready", internal_status: null, sync_error: null, page_count: 3,
      last_sync_at: expect.any(String),
    });
    expect(store.listWikiAudit("default", wikiId).map((entry) => entry.action))
      .not.toContain("failed");
  });

  it("persists ready before summary generation finishes", async () => {
    let release!: () => void;
    let started!: () => void;
    const summaryStarted = new Promise<void>((resolve) => { started = resolve; });
    const summaryPending = new Promise<string>((resolve) => { release = () => resolve("summary"); });
    vi.mocked(generateWikiSummary).mockImplementation(() => { started(); return summaryPending; });
    service.ingest("default", "team", wikiId);
    await summaryStarted;
    try {
      const reader = createDb({ path: join(root, "knowledge.db") });
      try {
        expect(new SqliteKnowledgeStore(reader.db).getWikiById("default", wikiId))
          .toMatchObject({ status: "ready", page_count: 3 });
      } finally { reader.raw.close(); }
    } finally { release(); }
    await service.onIdle();
  });

  it("retains the worker error when failure notification also fails, and supports retry", async () => {
    let attempts = 0;
    service = makeService(async (ctx) => {
      ctx.setInternalStatus("ingesting");
      if (attempts++ === 0) throw new Error("worker failed");
      return { pageCount: 2 };
    });
    vi.mocked(callbackTMC).mockRejectedValue(new Error("notification unavailable"));
    service.ingest("default", "team", wikiId);
    await service.onIdle();
    expect(service.getById("default", wikiId)).toMatchObject({
      status: "failed", internal_status: null, sync_error: "worker failed",
    });
    expect(service.ingest("default", "team", wikiId).kind).toBe("ok");
    await service.onIdle();
    expect(service.getById("default", wikiId)).toMatchObject({
      status: "ready", page_count: 2, sync_error: null,
    });
  });

  it("does not report ready when the terminal metadata commit fails", async () => {
    database.raw.exec(`CREATE TRIGGER reject_ready BEFORE UPDATE OF status ON knowledge_wiki
      WHEN NEW.status = 'ready' BEGIN SELECT RAISE(ABORT, 'metadata commit failed'); END;`);
    service.ingest("default", "team", wikiId);
    await service.onIdle();
    expect(service.getById("default", wikiId)).toMatchObject({
      status: "failed", internal_status: null, sync_error: expect.stringContaining("metadata commit failed"),
    });
    database.raw.exec("DROP TRIGGER reject_ready");
    service.ingest("default", "team", wikiId);
    await service.onIdle();
    expect(service.getById("default", wikiId)).toMatchObject({ status: "ready", page_count: 3 });
  });

  it("clears a stale ingest phase after restart without declaring partial work ready", () => {
    store.updateWikiStatus("default", wikiId, { status: "processing", internal_status: "ingesting" });
    reopen();
    expect(store.markInterruptedAsFailed()).toBe(1);
    expect(service.getById("default", wikiId)).toMatchObject({
      status: "failed", internal_status: null, sync_error: "interrupted by restart", page_count: null,
    });
    expect(store.markInterruptedAsFailed()).toBe(0);
  });

  it("retains source metadata if checkpoint housekeeping fails after commit", () => {
    const pragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, sql, options) {
      if (sql === "wal_checkpoint(TRUNCATE)") throw new Error("checkpoint unavailable");
      return pragma.call(this, sql, options);
    });
    expect(() => withWriteDb(dir, (db) => recordSourceIngestResult(db, {
      filename: "committed.md", sha256: "abc", size: 3, ok: true,
    }))).not.toThrow();
    vi.restoreAllMocks();
    expect(listSources(getReadDb(wikiId, dir))).toEqual([
      expect.objectContaining({ filename: "committed.md", status: "ingested" }),
    ]);
  });

  it("rolls back a failed index transaction", () => {
    expect(() => withWriteDb(dir, (db) => {
      recordSourceIngestResult(db, { filename: "rollback.md", sha256: "abc", size: 3, ok: true });
      throw new Error("index write failed");
    })).toThrow("index write failed");
    expect(service.rawLs("default", "team", wikiId)).toEqual([]);
  });

  it("keeps both raw listing routes readable with service auth enabled and protects writes", async () => {
    service.rawWrite("default", "team", wikiId, "readable.md", "source");
    const app = new Hono();
    app.use("/v3/*", createServiceAuthMiddleware({ serviceKey: "test-service-key" }, "/v3"));
    app.route("/v3/wiki", createWikiRoutes({
      wikiService: service,
      wikiMgr: createWikiSourceManager(join(root, "engines")),
      publicBaseUrl: "http://knowledge.invalid/v3",
    }));
    for (const path of ["/raw/ls", "/raw/list", "/raw/write", "/ingest"]) {
      const response = await app.request(`/v3/wiki${path}`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": "default" },
        body: JSON.stringify({ wiki_id: wikiId }),
      });
      const readOnly = path === "/raw/ls" || path === "/raw/list";
      expect(response.status).toBe(readOnly ? 200 : 401);
      if (readOnly) {
        expect((await readData<{ items: RawFileEntry[] }>(response)).items).toEqual([
          expect.objectContaining({ filename: "readable.md" }),
        ]);
      }
    }
  });

  it("persists 700 batched uploads and exposes them over HTTP after ingest and reopen", async () => {
    service = makeService(async (ctx) => {
      ctx.setInternalStatus("ingesting");
      withWriteDb(ctx.dir, (db) => {
        for (const source of listSources(db)) recordSourceIngestResult(db, { ...source, ok: true });
      });
      return { pageCount: 700 };
    });
    const manager = createWikiSourceManager(join(root, "engines"));
    const app = () => new Hono().route("/v3/wiki", createWikiRoutes({
      wikiService: service, wikiMgr: manager, publicBaseUrl: "http://knowledge.invalid/v3",
    }));
    const post = (path: string, body: object, tenant = "default") => app().request(`/v3/wiki${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": tenant },
      body: JSON.stringify(body),
    });
    for (let offset = 0; offset < 700; offset += 10) {
      const response = await post("/raw/write", {
        wiki_id: wikiId, team_id: "team",
        files: Array.from({ length: 10 }, (_, index) => ({ filename: `doc-${offset + index}.md`, content: `# Document ${offset + index}` })),
      });
      expect(response.status).toBe(200);
    }
    expect((await post("/ingest", { wiki_id: wikiId })).status).toBe(202);
    await service.onIdle();
    evictWikiDb(wikiId);
    reopen();
    const listed = await readData<{ items: WikiDetail[] }>(await post("/list", { team_id: "team" }));
    expect(listed.items).toEqual([expect.objectContaining({ wiki_id: wikiId, status: "ready", page_count: 700 })]);
    const detail = await readData<WikiDetail>(await post("/get", { wiki_id: wikiId }));
    expect(detail).toMatchObject({ status: "ready", page_count: 700 });
    for (const endpoint of ["/raw/ls", "/raw/list"]) {
      const response = await post(endpoint, { wiki_id: wikiId });
      expect(response.status).toBe(200);
      const data = await readData<{ items: RawFileEntry[] }>(response);
      expect(data.items).toHaveLength(700);
      expect(data.items.every((item: { status: string }) => item.status === "ingested")).toBe(true);
      expect((await post(endpoint, { wiki_id: wikiId }, "another-tenant")).status).toBe(404);
    }
  });
});
