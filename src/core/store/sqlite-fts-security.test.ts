import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
} from "./sqlite.js";

const SAFE_LITERAL_QUERY = /^"[^"]+"(?: OR "[^"]+")*$/;

function createFtsIndex(contents: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");
  const insert = db.prepare("INSERT INTO docs(content) VALUES (?)");
  for (const content of contents) insert.run(content);
  return db;
}

function searchRowIds(db: DatabaseSync, raw: string): number[] {
  const query = buildFtsQuery(raw);
  if (!query) return [];
  return (
    db
      .prepare("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid")
      .all(query) as Array<{ rowid: number }>
  ).map((row) => row.rowid);
}

afterEach(() => {
  _resetJiebaForTest();
});

describe("buildFtsQuery FTS5 security", () => {
  it.each([
    ['alpha" OR beta', "double quote and OR"],
    ["alpha' AND beta", "apostrophe and AND"],
    ["(alpha) NOT beta", "parentheses and NOT"],
    ["NEAR(alpha beta, 5)", "NEAR expression"],
    ["alpha*", "prefix operator"],
    ["content:alpha", "column filter"],
    ["alpha ^ beta", "caret syntax"],
    ['alpha OR "" OR * beta', "combined syntax"],
  ])("keeps %s as quoted literal terms (%s)", (raw) => {
    _setJiebaForTest(null);
    const db = createFtsIndex(["alpha beta", "content alpha", "unrelated"]);

    try {
      const query = buildFtsQuery(raw);
      expect(query).not.toBeNull();
      expect(query).toMatch(SAFE_LITERAL_QUERY);
      expect(() =>
        db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?").all(query),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("quotes hostile jieba tokens before they cross the MATCH boundary", () => {
    _setJiebaForTest({
      cutForSearch: () => [
        'alpha" OR beta',
        "gamma*",
        "NEAR(alpha beta)",
        "NOT",
        "(delta)",
      ],
    });
    const db = createFtsIndex(["alpha beta", "gamma", "delta"]);

    try {
      const query = buildFtsQuery("ignored raw input");
      expect(query).toMatch(SAFE_LITERAL_QUERY);
      expect(() =>
        db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?").all(query),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("prevents boolean and proximity words from changing query semantics", () => {
    _setJiebaForTest(null);
    const db = createFtsIndex([
      "alpha only",
      "beta only",
      "alpha beta",
      "unrelated",
    ]);

    try {
      // Raw FTS5 semantics would make the first query return no rows and the
      // second exclude beta matches. Literal tokenization keeps broad OR
      // recall instead.
      expect(searchRowIds(db, "alpha AND missing")).toEqual([1, 3]);
      expect(searchRowIds(db, "alpha NOT beta")).toEqual([1, 2, 3]);
      expect(searchRowIds(db, "NEAR(alpha beta)")).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });

  it("preserves embedded operator substrings and ordinary keyword recall", () => {
    _setJiebaForTest(null);
    const db = createFtsIndex([
      "android origin nearby",
      "android device",
      "unrelated",
    ]);

    try {
      expect(buildFtsQuery("android origin nearby")).toBe(
        '"android" OR "origin" OR "nearby"',
      );
      expect(searchRowIds(db, "android origin nearby")).toEqual([1, 2]);
    } finally {
      db.close();
    }
  });

  it("preserves jieba search tokens for normal Chinese recall", () => {
    _setJiebaForTest({
      cutForSearch: () => ["北京", "烤鸭", "北京烤鸭"],
    });
    const db = createFtsIndex([
      "北京 烤鸭 北京烤鸭",
      "上海 小笼包",
    ]);

    try {
      expect(buildFtsQuery("北京烤鸭")).toBe(
        '"北京" OR "烤鸭" OR "北京烤鸭"',
      );
      expect(searchRowIds(db, "北京烤鸭")).toEqual([1]);
    } finally {
      db.close();
    }
  });

  it.each([
    "",
    "   ",
    "\"'()***",
    "！@#￥%……&*（）",
  ])("returns null when no searchable token remains: %j", (raw) => {
    _setJiebaForTest(null);
    expect(buildFtsQuery(raw)).toBeNull();
  });
});
