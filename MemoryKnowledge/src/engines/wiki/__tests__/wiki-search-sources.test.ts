import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createWikiSourceManager } from "../manager.js";

it("reindexes one wiki without changing the search results of another", () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-search-sources-"));
  const manager = createWikiSourceManager(join(root, "state"));
  const registered: string[] = [];
  const pagePath = "wiki/entities/notes.md";
  const writePage = (name: string, title: string, body: string) => {
    writeFileSync(join(root, name, pagePath), `---\ntitle: ${title}\ntype: entity\n---\n${body}\n`);
  };
  const search = (name: string, query: string) => manager.search(name, query, 5, { hop: 0 });

  try {
    for (const [name, title] of [["finance", "복리 노트"], ["math", "수학 노트"]]) {
      mkdirSync(join(root, name, "wiki", "entities"), { recursive: true });
      writePage(name, title, "수익률");
      const source = manager.register({ name, path: join(root, name) });
      registered.push(name);
      expect(source.status).toBe("ready");
    }
    expect(search("finance", "수익률").results).toMatchObject([{ path: pagePath, title: "복리 노트" }]);
    expect(search("math", "수익률").results).toMatchObject([{ path: pagePath, title: "수학 노트" }]);

    writePage("finance", "복리 노트", "원금");
    expect(manager.sync("finance").status).toBe("ready");

    expect(search("finance", "수익률").results).toEqual([]);
    expect(search("finance", "원금").results).toMatchObject([{ path: pagePath, title: "복리 노트" }]);
    expect(search("math", "수익률").results).toMatchObject([{ path: pagePath, title: "수학 노트" }]);
    expect(search("math", "원금").results).toEqual([]);
  } finally {
    try {
      for (const name of registered) manager.remove(name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
