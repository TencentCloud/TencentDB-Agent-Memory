import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, lstatSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";
import { createWikiSourceManager } from "../src/engines/wiki/manager.js";
import { createWikiRoutes } from "../src/routes/wiki.js";
import { accessLog } from "../src/middleware/response-envelope.js";

const created: Array<{ root: string; raw: ReturnType<typeof createDb>["raw"] }> = [];
afterEach(() => { for (const { root, raw } of created.splice(0)) { raw.close(); rmSync(root, { recursive: true, force: true }); } vi.restoreAllMocks(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "okf-api-"));
  const { db, raw } = createDb({ path: ":memory:" }); created.push({ root, raw });
  const store = new SqliteKnowledgeStore(db);
  const worker = vi.fn(async () => ({}));
  const warn = vi.fn();
  const service = new WikiService({ store, dataRoot: join(root, "data"), worker, logger: { warn } });
  const manager = createWikiSourceManager(join(root, "manager"));
  const row = service.create({ service_id: "service-a", team_id: "team-a", name: "Knowledge" }).row;
  const app = new Hono(); app.use("*", accessLog());
  app.route("/wiki", createWikiRoutes({ wikiService: service, wikiMgr: manager, publicBaseUrl: "http://test/wiki" }));
  const post = (path: string, body: unknown, serviceId = "service-a") => app.request(`/wiki/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": serviceId }, body: JSON.stringify(body),
  });
  return { service, manager, store, worker, row, post, root, warn };
}
const fixture = () => [
  { path: "index.md", content: '---\nokf_version: "0.2"\n---\n# Index\n* [A](/nested/a.md)\n' },
  { path: "nested/a.md", content: "---\ntype: CustomType\ntitle: Alpha\nstale_after: 2020-01-01T00:00:00Z\ngenerated: {by: agent/1, at: 2026-01-01T00:00:00Z}\nverified: {by: 'human:adam', at: 2025-01-01T00:00:00Z}\nextra: null\n---\n\n Alpha uniquequantum [Beta](../b.md).  \n" },
  { path: "b.md", content: "---\ntype: concept\ntitle: Beta\n---\nBeta quantum" },
  { path: "references/run.py", content: "raise Exception('never run')\n" },
];

describe("native OKF API with real tenant store, SQLite FTS and graph", () => {
  it("imports, indexes and exports without LLM or changing the document", async () => {
    const { row, post, service, store, worker, manager } = setup();
    const body = { team_id: "team-a", wiki_id: row.wiki_id, files: fixture() };
    const imported = await post("okf/import", body); expect(imported.status).toBe(200);
    expect(store.getWikiById("service-a", row.wiki_id)?.status).toBe("ready");
    expect(store.getWikiById("service-a", row.wiki_id)?.version).toBe(row.version + 1);
    expect(worker).not.toHaveBeenCalled();
    expect(readFileSync(join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki/nested/a.md"), "utf-8")).toBe(fixture()[1].content);
    const search = manager.search(row.wiki_id, "uniquequantum");
    expect(search.results[0].okf).toMatchObject({ stale: true, trust: "human-reviewed", verificationPredatesContent: true, frontmatter: { extra: null } });
    expect(search.results[0].type).toBe("CustomType");
    const graph = manager.graph(row.wiki_id);
    expect(graph.edges.some((e) => new Set([e.source, e.target]).has("nested/a") && new Set([e.source, e.target]).has("b"))).toBe(true);
    const response = await post("okf/export", { team_id: "team-a", wiki_id: row.wiki_id }); expect(response.status).toBe(200);
    const envelope = await response.json();
    const files = envelope.data.files;
    const a = files.find((f: { path: string }) => f.path === "nested/a.md");
    expect(Buffer.from(a.content, "base64").toString("utf-8")).toBe(fixture()[1].content);
    // Reserved index files and non-Markdown reference code are not indexed as concepts.
    expect(manager.getPages(row.wiki_id).map((p) => p.id)).toEqual(expect.arrayContaining(["nested/a", "b"]));
    expect(manager.getPages(row.wiki_id).some((p) => p.id === "index")).toBe(false);
  });
  it.each(["okf/import", "okf/export"])("does not expose or mutate a foreign service/team through %s", async (path) => {
    const { row, post } = setup();
    const body = { team_id: "team-a", wiki_id: row.wiki_id, files: fixture() };
    expect((await post(path, body, "service-b")).status).toBe(404);
    expect((await post(path, { ...body, team_id: "team-b" })).status).toBe(404);
  });
  it("rejects writes and exports during queued/active ingestion", async () => {
    const { row, post, store } = setup();
    for (const status of ["pending", "processing"] as const) {
      store.updateWikiStatus("service-a", row.wiki_id, { status });
      const body = { team_id: "team-a", wiki_id: row.wiki_id, files: fixture() };
      expect((await post("okf/import", body)).status).toBe(409);
      expect((await post("okf/export", body)).status).toBe(409);
    }
  });
  it("validation cannot create data and reports optional-family warnings", async () => {
    const { row, post, manager } = setup();
    expect((await post("okf/validate", { files: fixture() })).status).toBe(200);
    expect(manager.get(row.wiki_id)).toBeUndefined();
    expect((await post("okf/validate", { files: [{ path: "../x.md", content: "bad" }] })).status).toBe(400);
  });
  it("existing page/write still locks a valid OKF page, preserving its custom metadata", async () => {
    const { row, post, service } = setup();
    const response = await post("page/write", { team_id: "team-a", wiki_id: row.wiki_id, pages: [{ ref: "custom/page", content: fixture()[1].content }] });
    expect(response.status).toBe(200);
    const content = readFileSync(join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki/custom/page.md"), "utf-8");
    expect(content).toContain("locked: true"); expect(content).toContain("extra: null");
  });
  it("reserves nested index/log from ordinary page editing", async () => {
    const { row, post } = setup();
    for (const ref of ["nested/index", "nested/log"]) {
      expect((await post("page/write", { team_id: "team-a", wiki_id: row.wiki_id, pages: [{ ref, content: "# File" }] })).status).toBe(400);
    }
  });

  it("POST /okf/recover returns 500 without leaking raw paths and changes row to failed on error", async () => {
    const { row, post, store, service } = setup();
    store.updateWikiStatus("service-a", row.wiki_id, { status: "processing" });
    const conflictRes = await post("okf/recover", { team_id: "team-a", wiki_id: row.wiki_id });
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json()).message).toContain("unrelated ingestion");
    expect(store.getWikiById("service-a", row.wiki_id)?.status).toBe("processing");

    store.updateWikiStatus("service-a", row.wiki_id, { status: "failed" });

    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");

    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, "{ malformed JSON }");

    const res = await post("okf/recover", { team_id: "team-a", wiki_id: row.wiki_id });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).not.toContain("okf-journal.json");
    expect(body.message).toContain("Recovery failed:");

    const updatedRow = store.getWikiById("service-a", row.wiki_id);
    expect(updatedRow?.status).toBe("failed");
    expect(updatedRow?.sync_error).not.toContain("okf-journal.json");

    // Check audit logs for no leaked paths
    const audits = store.listWikiAudit("service-a", row.wiki_id);
    const failedAudit = audits.find(a => a.action === "failed");
    expect(failedAudit).toBeDefined();
    expect(failedAudit?.detail).not.toContain("okf-journal.json");
  });

  it("POST /okf/recover idempotent no-op returns 200 without changing status", async () => {
    const { row, post, store } = setup();
    store.updateWikiStatus("service-a", row.wiki_id, { status: "ready" });
    const res = await post("okf/recover", { team_id: "team-a", wiki_id: row.wiki_id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.action).toBe("no_op");

    const updated = store.getWikiById("service-a", row.wiki_id);
    expect(updated?.status).toBe("ready");
  });

  it("POST /okf/recover rejects foreign team", async () => {
    const { row, post } = setup();
    const res = await post("okf/recover", { team_id: "team-b", wiki_id: row.wiki_id });
    expect(res.status).toBe(404);
  });

  it("reopens SQLite and succeeds recovery when wiki is ready for roll-forward", async () => {
    const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { randomUUID } = await import("node:crypto");

    const root = mkdtempSync(join(tmpdir(), "okf-api-reopen-"));
    const dbPath = join(root, "store.db");
    const { db, raw } = createDb({ path: dbPath });
    const store = new SqliteKnowledgeStore(db);
    const worker = vi.fn(async () => ({}));
    const dataRoot = join(root, "data");
    const service = new WikiService({ store, dataRoot, worker });

    const row = service.create({ service_id: "service-a", team_id: "team-a", name: "Reopen" }).row;
    store.updateWikiStatus("service-a", row.wiki_id, { status: "ready" });

    const wikiDir = join(service.dirFor("service-a", "team-a", row.wiki_id), "wiki");
    const journalPath = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");

    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "sentinel.md"), "---\nokf_version: \"0.2\"\ntype: concept\ntitle: test\n---\ntest-content");

    const stageName = `${dirname(wikiDir)}/wiki.okf-stage-${randomUUID()}`;
    const backupName = `${dirname(wikiDir)}/wiki.okf-backup-${randomUUID()}`;

    writeFileSync(journalPath, JSON.stringify({
      wikiDir,
      backupDir: backupName,
      stageDir: stageName,
      targetVersion: row.version + 1,
      phase: "indexing"
    }));
    mkdirSync(backupName, { recursive: true });
    writeFileSync(join(backupName, "backup-sentinel.md"), "backup-content");

    raw.close();

    // Reopen DB
    const { db: db2, raw: raw2 } = createDb({ path: dbPath });
    created.push({ root, raw: raw2 });
    const store2 = new SqliteKnowledgeStore(db2);
    const service2 = new WikiService({ store: store2, dataRoot, worker: vi.fn(async () => ({})) });
    const manager2 = createWikiSourceManager(join(root, "manager"));
    const app2 = new Hono();
    app2.use("*", accessLog());
    app2.route("/wiki", createWikiRoutes({ wikiService: service2, wikiMgr: manager2, publicBaseUrl: "http://test" }));

    const post2 = (path: string, body: unknown) => app2.request(`/wiki/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": "service-a" }, body: JSON.stringify(body),
    });

    expect(existsSync(backupName)).toBe(true);

    const res = await post2("okf/recover", { team_id: "team-a", wiki_id: row.wiki_id });
    expect(res.status).toBe(200);
    const bodyRes = await res.json();
    expect(bodyRes.data.action).toBe("rolled_forward");

    // Assert exactly imported bytes and cleanup
    expect(readFileSync(join(wikiDir, "sentinel.md"), "utf8")).toBe("---\nokf_version: \"0.2\"\ntype: concept\ntitle: test\n---\ntest-content");
    expect(existsSync(backupName)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);

    const updated = store2.getWikiById("service-a", row.wiki_id);
    expect(updated?.status).toBe("ready");
    expect(updated?.version).toBe(row.version + 1);

    // Repeated recovery is no-op
    const syncSpy = vi.spyOn(manager2, "sync");
    const resRepeat = await post2("okf/recover", { team_id: "team-a", wiki_id: row.wiki_id });
    expect(resRepeat.status).toBe(200);
    expect((await resRepeat.json()).data.action).toBe("no_op");
    expect(syncSpy).not.toHaveBeenCalled();
    expect(store2.getWikiById("service-a", row.wiki_id)?.version).toBe(updated?.version);
  });

  it("preserves dangling journal evidence through service recovery and API import/recovery", async () => {
    const { row, post, service, root } = setup();
    const journal = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");
    const absentTarget = join(root, "absent-journal-target");
    symlinkSync(absentTarget, journal);
    expect(() => service.okfRecover("service-a", "team-a", row.wiki_id)).toThrow("symbolic link");
    const ids = { team_id: "team-a", wiki_id: row.wiki_id };
    expect((await post("okf/recover", ids)).status).toBe(500);
    expect((await post("okf/import", { ...ids, files: fixture() })).status).toBe(409);
    expect(lstatSync(journal).isSymbolicLink()).toBe(true);
    expect(existsSync(absentTarget)).toBe(false);
  });

  it("redacts indexing and audit-write exceptions from HTTP, status, audits and logs", async () => {
    const { row, post, service, store, manager, warn } = setup();
    const secret = "SYNTHETIC-SECRET-843fa"; // gitleaks:allow -- synthetic exception marker, not a credential
    vi.spyOn(manager, "sync").mockImplementation(() => { throw new Error(secret); });
    const audit = vi.spyOn(store, "appendWikiAudit").mockImplementation(() => { throw new Error(secret); });
    const response = await post("okf/import", { team_id: "team-a", wiki_id: row.wiki_id, files: fixture() });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(store.getWikiById("service-a", row.wiki_id)?.status).toBe("failed");
    expect(JSON.stringify(store.getWikiById("service-a", row.wiki_id))).not.toContain(secret);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    audit.mockRestore();
    service.okfIndexed("service-a", "team-a", row.wiki_id, 0, secret);
    const persisted = store.listWikiAudit("service-a", row.wiki_id);
    expect(persisted.some(a => a.action === "failed")).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain(secret);
  });

  it("fails HTTP finalization and retains backup bytes and journal when state becomes ambiguous", async () => {
    const { row, post, service, store, manager } = setup();
    const ids = { team_id: "team-a", wiki_id: row.wiki_id };
    expect((await post("okf/import", { ...ids, files: fixture() })).status).toBe(200);
    service.okfImport("service-a", "team-a", row.wiki_id, fixture(), true);
    const path = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");
    const journal = JSON.parse(readFileSync(path, "utf8"));
    const sync = manager.sync.bind(manager);
    vi.spyOn(manager, "sync").mockImplementation(name => {
      const result = sync(name);
      writeFileSync(path, JSON.stringify({ ...journal, phase: "started" }));
      return result;
    });
    expect((await post("okf/recover", ids)).status).toBe(500);
    expect(store.getWikiById("service-a", row.wiki_id)?.status).toBe("failed");
    expect(JSON.parse(readFileSync(path, "utf8")).phase).toBe("started");
    expect(readFileSync(join(journal.backupDir, "index.md"), "utf8")).toBe(fixture()[0].content);
  });

  it.each(["directory", "unknown-field"])("preserves an invalid journal (%s)", async kind => {
    const { row, post, service } = setup();
    service.okfImport("service-a", "team-a", row.wiki_id, fixture());
    const path = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");
    if (kind === "directory") { rmSync(path); mkdirSync(path); }
    else writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), unexpected: true }));
    const response = await post("okf/recover", { team_id: "team-a", wiki_id: row.wiki_id });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain(kind === "directory" ? "regular file" : "unknown fields");
    expect(existsSync(path)).toBe(true);
  });

  it("blocks ordinary ingestion until an interrupted OKF import is recovered", async () => {
    const { row, post, service, store, worker } = setup();
    service.rawWrite("service-a", "team-a", row.wiki_id, "source.md", "Synthetic source for ingestion");
    service.okfImport("service-a", "team-a", row.wiki_id, fixture());
    service.okfIndexed("service-a", "team-a", row.wiki_id, 0, "synthetic index failure");
    const before = store.getWikiById("service-a", row.wiki_id);
    const path = join(service.dirFor("service-a", "team-a", row.wiki_id), "okf-journal.json");
    const journal = readFileSync(path);
    expect((await post("ingest", { wiki_id: row.wiki_id })).status).toBe(409);
    expect(service.sync("service-a", "team-a", row.wiki_id)).toEqual({ kind: "recovery_required" });
    expect(worker).not.toHaveBeenCalled();
    expect(store.getWikiById("service-a", row.wiki_id)).toEqual(before);
    expect(readFileSync(path)).toEqual(journal);
  });
});
