/**
 * WikiService ingest metadata persistence (issue #1232).
 *
 * After a successful ingest the knowledge.db wiki row must be committed
 * (status=ready, page_count set) so /v3/wiki/list and raw/ls can find the asset.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../db/client.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { WikiService, type WikiWorker } from "./wiki-service.js";
import { initIndexDb, recordSourceIngestResult, sha256, withWriteDb } from "../engines/wiki/index-db.js";

const SERVICE = "default";
const TEAM = "test-team-123";

function makeFiles(n: number, offset = 0): { filename: string; content: string }[] {
  return Array.from({ length: n }, (_, i) => {
    const idx = offset + i + 1;
    return { filename: `doc${idx}.md`, content: `# Doc ${idx}\n\nbody ${idx}\n` };
  });
}

function setup(worker: WikiWorker) {
  const dataRoot = mkdtempSync(join(tmpdir(), "wiki-meta-"));
  const { db } = createDb({ path: ":memory:" });
  const store = new SqliteKnowledgeStore(db);
  const service = new WikiService({ store, dataRoot, worker });
  return { dataRoot, store, service };
}

describe("WikiService ingest metadata persistence", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("commits wiki asset metadata after batched raw writes + successful ingest", async () => {
    const worker: WikiWorker = async (ctx) => {
      ctx.setInternalStatus("ingesting");
      const wikiDir = join(ctx.dir, "wiki");
      mkdirSync(wikiDir, { recursive: true });
      for (let i = 1; i <= 15; i++) {
        writeFileSync(join(wikiDir, `page-${i}.md`), `---\ntitle: Page ${i}\ntype: other\n---\n# Page ${i}\n`);
      }
      ctx.setInternalStatus("rebuilding-index");
      return { pageCount: 15 };
    };
    const { dataRoot, store, service } = setup(worker);
    dirs.push(dataRoot);

    const { row } = service.create({ service_id: SERVICE, team_id: TEAM, name: "Test Wiki" });
    const wikiId = row.wiki_id;

    // Mimic /v3/wiki/raw/write batches of 10 (API limit).
    const batch1 = service.rawWriteMany(SERVICE, TEAM, wikiId, makeFiles(10));
    const batch2 = service.rawWriteMany(SERVICE, TEAM, wikiId, makeFiles(5, 10));
    expect(batch1).not.toBeNull();
    expect(batch2).not.toBeNull();
    if (batch1 && typeof batch1 !== "string") expect(batch1).toHaveLength(10);
    if (batch2 && typeof batch2 !== "string") expect(batch2).toHaveLength(5);

    const ingest = service.ingest(SERVICE, TEAM, wikiId);
    expect(ingest.kind).toBe("ok");
    await service.onIdle(wikiId);

    const listed = service.list(SERVICE, TEAM);
    expect(listed).toHaveLength(1);
    expect(listed[0].wiki_id).toBe(wikiId);
    expect(listed[0].status).toBe("ready");
    expect(listed[0].internal_status).toBeNull();
    expect(listed[0].page_count).toBe(15);
    expect(listed[0].sync_error).toBeNull();

    const got = store.getWikiById(SERVICE, wikiId);
    expect(got?.status).toBe("ready");
    expect(got?.page_count).toBe(15);

    const raw = service.rawLs(SERVICE, TEAM, wikiId);
    expect(raw).not.toBeNull();
    expect(raw).toHaveLength(15);
  });

  it("does not revert ready metadata when a post-ready hook throws", async () => {
    const worker: WikiWorker = async () => ({ pageCount: 4 });
    const dataRoot = mkdtempSync(join(tmpdir(), "wiki-meta-"));
    dirs.push(dataRoot);
    const { db } = createDb({ path: ":memory:" });
    const store = new SqliteKnowledgeStore(db);
    const service = new WikiService({
      store,
      dataRoot,
      worker,
      logger: {
        info: () => {
          throw new Error("logger exploded after commit");
        },
      },
    });

    const { row } = service.create({ service_id: SERVICE, team_id: TEAM, name: "Hook Wiki" });
    service.rawWriteMany(SERVICE, TEAM, row.wiki_id, makeFiles(2));
    service.ingest(SERVICE, TEAM, row.wiki_id);
    await service.onIdle(row.wiki_id);

    const got = service.get(SERVICE, TEAM, row.wiki_id);
    expect(got?.status).toBe("ready");
    expect(got?.page_count).toBe(4);
  });

  it("marks failed on worker error, then retry persists ready metadata", async () => {
    let attempts = 0;
    const worker: WikiWorker = async () => {
      attempts++;
      if (attempts === 1) throw new Error("llm unavailable");
      return { pageCount: 3 };
    };
    const { dataRoot, service } = setup(worker);
    dirs.push(dataRoot);

    const { row } = service.create({ service_id: SERVICE, team_id: TEAM, name: "Retry Wiki" });
    service.rawWriteMany(SERVICE, TEAM, row.wiki_id, makeFiles(3));

    service.ingest(SERVICE, TEAM, row.wiki_id);
    await service.onIdle(row.wiki_id);
    const failed = service.get(SERVICE, TEAM, row.wiki_id);
    expect(failed?.status).toBe("failed");
    expect(failed?.internal_status).toBeNull();
    expect(failed?.page_count).toBeNull();
    expect(failed?.sync_error).toMatch(/llm unavailable/);

    const retry = service.ingest(SERVICE, TEAM, row.wiki_id);
    expect(retry.kind).toBe("ok");
    await service.onIdle(row.wiki_id);
    const ready = service.get(SERVICE, TEAM, row.wiki_id);
    expect(ready?.status).toBe("ready");
    expect(ready?.page_count).toBe(3);
    expect(ready?.sync_error).toBeNull();
  });

  it("rejects concurrent ingest while processing (busy)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const worker: WikiWorker = async (ctx) => {
      ctx.setInternalStatus("ingesting");
      await gate;
      return { pageCount: 1 };
    };
    const { dataRoot, service } = setup(worker);
    dirs.push(dataRoot);

    const { row } = service.create({ service_id: SERVICE, team_id: TEAM, name: "Busy Wiki" });
    service.rawWriteMany(SERVICE, TEAM, row.wiki_id, makeFiles(1));
    const first = service.ingest(SERVICE, TEAM, row.wiki_id);
    expect(first.kind).toBe("ok");

    const second = service.ingest(SERVICE, TEAM, row.wiki_id);
    expect(second.kind).toBe("busy");

    release();
    await service.onIdle(row.wiki_id);
    expect(service.get(SERVICE, TEAM, row.wiki_id)?.status).toBe("ready");
  });

  it("recovers knowledge.db metadata from on-disk ingest artifacts after interruption", async () => {
    const worker: WikiWorker = async () => {
      throw new Error("should not run during recovery");
    };
    const { dataRoot, store, service } = setup(worker);
    dirs.push(dataRoot);

    const { row } = service.create({ service_id: SERVICE, team_id: TEAM, name: "Crash Wiki" });
    const wikiId = row.wiki_id;
    const written = service.rawWriteMany(SERVICE, TEAM, wikiId, makeFiles(2));
    expect(Array.isArray(written)).toBe(true);

    const dir = service.dirFor(SERVICE, TEAM, wikiId);
    const wikiDir = join(dir, "wiki");
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "recovered.md"), "---\ntitle: Recovered\ntype: other\n---\n# Recovered\n");
    initIndexDb(dir);
    withWriteDb(dir, (db) => {
      for (const f of makeFiles(2)) {
        recordSourceIngestResult(db, {
          filename: f.filename,
          sha256: sha256(f.content),
          size: Buffer.byteLength(f.content, "utf-8"),
          ok: true,
        });
      }
    });

    // Simulate crash after LLM/index write: row stuck ingesting, page_count null.
    store.updateWikiStatus(SERVICE, wikiId, {
      status: "failed",
      internal_status: "ingesting",
      page_count: null,
    });
    expect(store.getWikiById(SERVICE, wikiId)?.status).toBe("failed");

    const recovered = service.recoverInterruptedFromDisk();
    expect(recovered).toBe(1);

    const got = service.get(SERVICE, TEAM, wikiId);
    expect(got?.status).toBe("ready");
    expect(got?.internal_status).toBeNull();
    expect(got?.page_count).toBe(1);
    expect(service.rawLs(SERVICE, TEAM, wikiId)).toHaveLength(2);
  });

  it("clears internal_status when marking interrupted ingest as failed", async () => {
    const { dataRoot, store, service } = setup(async () => ({ pageCount: 0 }));
    dirs.push(dataRoot);
    const { row } = service.create({ service_id: SERVICE, team_id: TEAM, name: "Interrupted" });
    store.updateWikiStatus(SERVICE, row.wiki_id, {
      status: "processing",
      internal_status: "ingesting",
    });
    expect(store.markInterruptedAsFailed()).toBeGreaterThan(0);
    const got = store.getWikiById(SERVICE, row.wiki_id);
    expect(got?.status).toBe("failed");
    expect(got?.internal_status).toBeNull();
  });

  it("does not recover a wiki whose sources never ingested", async () => {
    const { dataRoot, store, service } = setup(async () => ({ pageCount: 0 }));
    dirs.push(dataRoot);

    const { row } = service.create({ service_id: SERVICE, team_id: TEAM, name: "Empty Crash" });
    service.rawWriteMany(SERVICE, TEAM, row.wiki_id, makeFiles(2));
    store.updateWikiStatus(SERVICE, row.wiki_id, {
      status: "failed",
      internal_status: "ingesting",
    });

    expect(service.recoverInterruptedFromDisk()).toBe(0);
    expect(service.get(SERVICE, TEAM, row.wiki_id)?.status).toBe("failed");
  });
});
