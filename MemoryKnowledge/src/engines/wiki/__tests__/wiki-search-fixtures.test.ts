import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWikiSourceManager } from "../manager.js";

const documents = [
  { id: "redis-cache", title: "Redis cache", body: "Use eviction to manage memory." },
  { id: "indexing", title: "数据库索引", body: "使用索引加速查询。" },
  { id: "compound-interest", title: "복리 계산", body: "원금과 이자를 함께 계산합니다." },
];

describe("wiki keyword search with multilingual Markdown", () => {
  let root: string;
  let name: string;
  let manager: ReturnType<typeof createWikiSourceManager>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wiki-search-fixtures-"));
    name = basename(root);
    const entities = join(root, "wiki", "entities");
    mkdirSync(entities, { recursive: true });
    for (const { id, title, body } of documents) {
      writeFileSync(
        join(entities, `${id}.md`),
        `---\ntitle: ${title}\ntype: entity\n---\n${body}\n`,
      );
    }
    manager = createWikiSourceManager(join(root, "state"));
    const source = manager.register({ name, path: root });
    expect(source.status).toBe("ready");
    expect(source.pageCount).toBe(documents.length);
  });

  afterEach(() => {
    try {
      manager?.remove(name);
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { query: "REDIS", id: "redis-cache", title: "Redis cache" },
    { query: "eviction", id: "redis-cache", title: "Redis cache" },
    { query: "索引", id: "indexing", title: "数据库索引" },
    { query: "查询", id: "indexing", title: "数据库索引" },
    { query: "복리", id: "compound-interest", title: "복리 계산" },
    { query: "원금과", id: "compound-interest", title: "복리 계산" },
  ])("finds the expected page for $query", ({ query, id, title }) => {
    const response = manager.search(name, query, 5, { hop: 0 });
    expect(response.count).toBe(1);
    expect(response.results).toMatchObject([{ path: `wiki/entities/${id}.md`, title, hop: 0 }]);
  });

  it("returns no hits for a term absent from the corpus", () => {
    expect(manager.search(name, "nonexistent", 5, { hop: 0 })).toEqual({
      results: [],
      links: [],
      count: 0,
    });
  });

  it("refreshes search terms after a Markdown page changes", () => {
    const search = (query: string) => manager.search(name, query, 5, { hop: 0 });
    expect(search("원금과").count).toBe(1);
    writeFileSync(
      join(root, "wiki", "entities", "compound-interest.md"),
      "---\ntitle: 복리 계산\ntype: entity\n---\n연복리 수익률을 예시로 설명합니다.\n",
    );

    expect(manager.sync(name).status).toBe("ready");
    expect(search("원금과").count).toBe(0);
    expect(search("연복리").results).toMatchObject([{ path: "wiki/entities/compound-interest.md" }]);
  });
});
