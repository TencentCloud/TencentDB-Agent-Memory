import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  sanitizeFts5Input,
} from "./sqlite.js";

const SAFE_LITERAL_QUERY = /^"(?:[^"]|"")+"(?: OR "(?:[^"]|"")+")*$/;

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

describe("sanitizeFts5Input", () => {
  it("removes standalone uppercase boolean and proximity operators", () => {
    const value = sanitizeFts5Input("alpha AND beta OR NOT gamma NEAR(delta)");
    expect(value.replace(/\s+/g, " ").trim()).toBe("alpha beta gamma (delta)");
  });

  it("preserves lowercase prose and embedded operator substrings", () => {
    const value =
      "and or not near And Or Not Near android origin notebook nearby 中文AND测试";
    expect(sanitizeFts5Input(value)).toBe(value);
  });
});

describe("buildFtsQuery", () => {
  it("sanitizes operators before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta or gamma")).toBe(
      '"alpha" OR "beta" OR "or" OR "gamma"',
    );
    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
  });

  it("sanitizes operators before jieba tokenization", () => {
    const seen: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string): string[] {
        seen.push(text);
        return text.split(/\s+/);
      },
    });

    expect(buildFtsQuery("用户 AND TypeScript OR 记忆")).toBe(
      '"用户" OR "TypeScript" OR "记忆"',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toMatch(/\b(?:AND|OR|NOT|NEAR)\b/);
  });

  it("contains hostile tokenizer output inside escaped phrase literals", () => {
    _setJiebaForTest({
      cutForSearch: () => [
        'alpha" OR beta',
        "gamma*",
        "NEAR(alpha beta)",
        "NOT",
        "(delta)",
      ],
    });
    const db = createFtsIndex(["alpha OR beta", "gamma", "delta", "unrelated"]);

    try {
      const query = buildFtsQuery("ignored raw input");
      expect(query).toBe(
        '"alpha"" OR beta" OR "gamma*" OR "NEAR(alpha beta)" OR "(delta)"',
      );
      expect(query).toMatch(SAFE_LITERAL_QUERY);
      expect(() =>
        db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?").all(query),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it.each([
    ['alpha" OR beta', "quote and OR"],
    ["alpha' AND beta", "apostrophe and AND"],
    ["(alpha) NOT beta", "parentheses and NOT"],
    ["NEAR(alpha beta, 5)", "NEAR expression"],
    ["alpha*", "prefix operator"],
    ["content:alpha", "column filter"],
    ["alpha ^ beta", "caret syntax"],
  ])("executes %s as literal terms (%s)", (raw) => {
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

  it("prevents raw operator text from changing OR-recall semantics", () => {
    _setJiebaForTest(null);
    const db = createFtsIndex([
      "alpha only",
      "beta only",
      "alpha beta",
      "AND boolean operator",
      "near field",
      "unrelated",
    ]);

    try {
      expect(searchRowIds(db, "alpha AND missing")).toEqual([1, 3]);
      expect(searchRowIds(db, "alpha NOT beta")).toEqual([1, 2, 3]);
      expect(searchRowIds(db, "NEAR(alpha beta)")).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });

  it("preserves lowercase terms and benign keyword recall", () => {
    _setJiebaForTest(null);
    const db = createFtsIndex([
      "research and development",
      "meet near the station",
      "android origin notebook nearby",
      "中文AND测试",
      "unrelated",
    ]);

    try {
      expect(searchRowIds(db, "and")).toEqual([1]);
      expect(searchRowIds(db, "near")).toEqual([2]);
      expect(searchRowIds(db, "android origin notebook nearby")).toEqual([3]);
      expect(searchRowIds(db, "中文AND测试")).toEqual([4]);
    } finally {
      db.close();
    }
  });

  it("preserves normal Chinese jieba search tokens", () => {
    _setJiebaForTest({
      cutForSearch: () => ["北京", "烤鸭", "北京烤鸭"],
    });
    const db = createFtsIndex(["北京 烤鸭 北京烤鸭", "上海 小笼包"]);

    try {
      expect(buildFtsQuery("北京烤鸭")).toBe(
        '"北京" OR "烤鸭" OR "北京烤鸭"',
      );
      expect(searchRowIds(db, "北京烤鸭")).toEqual([1]);
    } finally {
      db.close();
    }
  });
});
