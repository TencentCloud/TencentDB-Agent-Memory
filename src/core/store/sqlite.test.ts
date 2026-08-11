import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

describe("buildFtsQuery", () => {
  beforeEach(() => {
    _setJiebaForTest(null);
  });

  afterEach(() => {
    _resetJiebaForTest();
  });

  it("quotes normal tokens and joins them with OR", () => {
    expect(buildFtsQuery("TypeScript SQLite memory")).toBe('"TypeScript" OR "SQLite" OR "memory"');
  });

  it("removes FTS5 operators supplied by user input", () => {
    expect(buildFtsQuery("alpha OR beta AND NOT NEAR gamma")).toBe('"alpha" OR "beta" OR "gamma"');
  });

  it("drops FTS5 punctuation while keeping searchable words", () => {
    expect(buildFtsQuery('"project") OR content:* NOT secret')).toBe('"project" OR "content" OR "secret"');
  });

  it("normalizes full-width text and filters common Chinese stop words", () => {
    expect(buildFtsQuery("我 在 上海 写 ＴｙｐｅＳｃｒｉｐｔ")).toBe('"上海" OR "写" OR "TypeScript"');
  });

  it("returns null when no searchable terms remain", () => {
    expect(buildFtsQuery('OR AND NOT NEAR "()" *')).toBeNull();
  });

  it("produces MATCH expressions that SQLite FTS5 can execute safely", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
    db.prepare("INSERT INTO docs(content) VALUES (?)").run("project secret memory");

    try {
      const query = buildFtsQuery('"project") OR content:* NOT secret');
      expect(query).toBe('"project" OR "content" OR "secret"');

      const rows = db.prepare("SELECT content FROM docs WHERE docs MATCH ?").all(query);
      expect(rows).toEqual([{ content: "project secret memory" }]);
    } finally {
      db.close();
    }
  });
});
