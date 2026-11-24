import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/client.js";
import { SqliteKnowledgeStore } from "../src/store/sqlite-store.js";
import { WikiService } from "../src/store/wiki-service.js";
import { createKnowledgeModule } from "../src/module.js";

const resources: Array<{ root: string; raw: ReturnType<typeof createDb>["raw"] }> = [];
afterEach(() => {
  for (const { root, raw } of resources.splice(0)) {
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "wiki-restart-"));
  const { db, raw } = createDb({ path: ":memory:" });
  resources.push({ root, raw });
  const store = new SqliteKnowledgeStore(db);
  const service = new WikiService({ store, dataRoot: root, worker: vi.fn(async () => ({})) });
  const row = service.create({ service_id: "synthetic-service", team_id: "synthetic-team", name: "Restart" }).row;
  store.updateWikiStatus(row.service_id, row.wiki_id, { status: "ready" });
  const project = service.dirFor(row.service_id, row.team_id, row.wiki_id);
  return { root, db, store, row, project };
}

function inventory(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [path, bytes] of Object.entries(inventory(join(dir, entry.name)))) out[entry.name + "/" + path] = bytes;
    } else out[entry.name] = readFileSync(join(dir, entry.name)).toString("base64");
  }
  return out;
}

describe("Wiki module restart preservation", () => {
  it("restores the real index without adding producer templates or changing supplied bytes", () => {
    const { root, db, row, project } = setup();
    const wiki = join(project, "wiki");
    mkdirSync(join(wiki, "assets"), { recursive: true });
    writeFileSync(join(wiki, "index.md"), '# Existing native index\r\n');
    writeFileSync(join(wiki, "topic.md"), '---\ntitle: Exact\ntype: concept\n---\nExact bytes\n');
    writeFileSync(join(wiki, "assets/bytes.bin"), Buffer.from([0, 255, 128, 10]));
    const before = inventory(wiki);
    for (let restart = 0; restart < 2; restart++) {
      const mod = createKnowledgeModule({ dataDir: root, db, llmConfig: {} as never });
      expect(inventory(wiki)).toEqual(before);
      expect(mod.wikiMgr.getPages(row.wiki_id).length).toBeGreaterThan(0);
    }
  });

  it("does not manufacture a replacement wiki tree when stored content is missing", () => {
    const { root, db, project } = setup();
    const wiki = join(project, "wiki");
    expect(existsSync(wiki)).toBe(false);
    createKnowledgeModule({ dataDir: root, db, llmConfig: {} as never });
    expect(existsSync(wiki)).toBe(false);
  });
});
