import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { createCredentialStore } from "../src/source-auth/credential-store.js";
import { AutoSyncScheduler } from "../src/store/auto-sync-scheduler.js";
import { createWikiImporter } from "../src/wiki-source/wiki-importer.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const f of cleanups.splice(0)) f(); vi.useRealTimers(); });
function setup() {
  const { db, raw } = createDb({ path: ":memory:" });
  cleanups.push(() => raw.close());
  const store = new SqliteKnowledgeStore(db);
  const credentials = createCredentialStore({ db });
  const wiki = store.createWiki({ service_id: "synthetic-service", team_id: "team-a", name: "synthetic-wiki" }).row;
  raw.prepare("UPDATE knowledge_wiki SET source_type = ?, source_url = ?, status = 'ready' WHERE wiki_id = ?").run("synthetic", "https://synthetic.invalid/wiki", wiki.wiki_id);
  credentials.put({ type: "wiki", serviceId: wiki.service_id, resourceId: wiki.wiki_id }, { kind: "bearer", secret: "synthetic-token" }, "synthetic");
  const get = vi.spyOn(credentials, "get");
  const provider = { resolveRoot: vi.fn(async () => ({ rootType: "doc", rootId: "synthetic-doc" })), listPages: vi.fn(async () => []) };
  const contextFor = vi.fn(() => ({ provider, ctx: {} }));
  const registry = { get: vi.fn(() => provider), contextFor };
  const rawWriteMany = vi.fn(() => []);
  const importer = createWikiImporter({ store, registry, wikiService: { rawWriteMany } } as any);
  const run = vi.spyOn(importer, "run");
  const scheduler = new AutoSyncScheduler({ store, credentialStore: credentials, wikiImporter: importer, cgService: {} as any, config: { enabled: true, scanIntervalMs: 60000, maxConcurrentSyncs: 1 } });
  cleanups.unshift(() => scheduler.stop());
  return { raw, wiki, get, provider, contextFor, importer, run, scheduler, rawWriteMany };
}
describe("Wiki queued ownership transitions with native SQLite", () => {
  for (const mode of ["unchanged", "team-changed", "deleted"]) {
    it(`checks queued ownership before credential access: ${mode}`, async () => {
      vi.useFakeTimers();
      const f = setup();
      f.scheduler.start();
      f.scheduler.triggerScan();
      expect(f.scheduler.getStatus().queueLength).toBe(1);
      if (mode === "team-changed") f.raw.prepare("UPDATE knowledge_wiki SET team_id = ? WHERE wiki_id = ?").run("team-b", f.wiki.wiki_id);
      if (mode === "deleted") f.raw.prepare("DELETE FROM knowledge_wiki WHERE wiki_id = ?").run(f.wiki.wiki_id);
      await vi.advanceTimersByTimeAsync(100);
      expect(f.scheduler.getStatus().queueLength).toBe(0);
      expect(f.scheduler.getStatus().activeSyncs).toBe(0);
      expect(f.get).toHaveBeenCalledTimes(mode === "unchanged" ? 1 : 0);
      expect(f.run).toHaveBeenCalledTimes(mode === "unchanged" ? 1 : 0);
      expect(f.contextFor).toHaveBeenCalledTimes(mode === "unchanged" ? 1 : 0);
      expect(f.provider.resolveRoot).toHaveBeenCalledTimes(mode === "unchanged" ? 1 : 0);
      expect(f.rawWriteMany).not.toHaveBeenCalled();
      if (mode === "team-changed") {
        f.get.mockClear(); f.run.mockClear(); f.contextFor.mockClear(); f.provider.resolveRoot.mockClear();
        f.scheduler.triggerScan();
        await vi.advanceTimersByTimeAsync(100);
        expect(f.run).toHaveBeenCalledWith("synthetic-service", "team-b", f.wiki.wiki_id, expect.objectContaining({ secret: "synthetic-token" }));
        expect(f.provider.resolveRoot).toHaveBeenCalledTimes(1);
      }
    });
  }
  it("direct importer refuses a stale team before provider access", async () => {
    const f = setup();
    f.raw.prepare("UPDATE knowledge_wiki SET team_id = ? WHERE wiki_id = ?").run("team-b", f.wiki.wiki_id);
    expect(await f.importer.run("synthetic-service", "team-a", f.wiki.wiki_id, { kind: "bearer", secret: "synthetic-token" })).toBe(0);
    expect(f.contextFor).not.toHaveBeenCalled();
    expect(f.provider.resolveRoot).not.toHaveBeenCalled();
    expect(f.rawWriteMany).not.toHaveBeenCalled();
  });
});
