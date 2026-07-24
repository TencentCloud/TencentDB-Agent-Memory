import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
} from "./sqlite.js";

const SAFE_LITERAL_QUERY = /^"(?:[^"]|"")+"(?: OR "(?:[^"]|"")+")*$/;

function createFtsDatabase(contents: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(content)");

  const insert = db.prepare("INSERT INTO docs(content) VALUES (?)");
  for (const content of contents) insert.run(content);

  return db;
}

function searchQueryRowIds(db: DatabaseSync, query: string | null): number[] {
  if (!query) return [];

  return (
    db
      .prepare("SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY rowid")
      .all(query) as Array<{ rowid: number }>
  ).map((row) => row.rowid);
}

function searchRowIds(db: DatabaseSync, raw: string): number[] {
  return searchQueryRowIds(db, buildFtsQuery(raw));
}

function searchTopRowIds(
  db: DatabaseSync,
  raw: string,
  limit: number,
): number[] {
  const query = buildFtsQuery(raw);
  if (!query) return [];

  return (
    db
      .prepare(
        "SELECT rowid FROM docs WHERE docs MATCH ? ORDER BY bm25(docs), rowid LIMIT ?",
      )
      .all(query, limit) as Array<{ rowid: number }>
  ).map((row) => row.rowid);
}

function recallAtK(actual: number[], expected: number[]): number {
  const expectedIds = new Set(expected);
  return actual.filter((rowId) => expectedIds.has(rowId)).length / expected.length;
}

function buildLegacyFallbackQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((token) => token.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" OR ");
}

afterEach(() => {
  // Force the next test to initialise its own tokenizer path.
  _resetJiebaForTest();
});

describe("buildFtsQuery", () => {
  it("builds a quoted OR query for ordinary Chinese and English text", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("北京 TypeScript")).toBe(
      '"北京" OR "TypeScript"',
    );
  });

  it("keeps FTS5 operator words as quoted literal search terms", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta OR NOT gamma NEAR delta")).toBe(
      '"alpha" OR "AND" OR "beta" OR "OR" OR "NOT" OR "gamma" OR "NEAR" OR "delta"',
    );
  });

  it("preserves lowercase prose and embedded operator substrings", () => {
    _setJiebaForTest(null);

    expect(
      buildFtsQuery(
        "research and development android origin notable nearby 中文AND测试",
      ),
    ).toBe(
      '"research" OR "and" OR "development" OR "android" OR "origin" OR "notable" OR "nearby" OR "中文AND测试"',
    );
  });

  it("passes raw text to jieba and quotes its operator tokens", () => {
    const seen: string[] = [];
    _setJiebaForTest({
      cutForSearch(text: string): string[] {
        seen.push(text);
        return text.split(/\s+/);
      },
    });

    expect(buildFtsQuery("用户 AND TypeScript OR 记忆")).toBe(
      '"用户" OR "AND" OR "TypeScript" OR "OR" OR "记忆"',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("用户 AND TypeScript OR 记忆");
  });

  it("escapes embedded double quotes with FTS5 quoted-string escaping", () => {
    _setJiebaForTest({
      cutForSearch: () => ['alpha"beta'],
    });

    expect(buildFtsQuery("ignored raw input")).toBe('"alpha""beta"');
  });

  it("escapes hostile tokenizer output before MATCH execution", () => {
    _setJiebaForTest({
      cutForSearch: () => [
        'alpha" OR beta',
        "gamma*",
        "NEAR(alpha beta)",
        "NOT",
        "(delta)",
      ],
    });
    const db = createFtsDatabase(["alpha beta", "gamma", "delta"]);

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

  it.each([
    ["alpha", "BNF phrase"],
    ["alpha*", "BNF prefix phrase"],
    ["alpha + beta", "BNF phrase concatenation"],
    ["NEAR(alpha beta, 5)", "BNF NEAR group"],
    ["(alpha OR beta)", "BNF parenthesized query"],
    ["alpha AND beta OR NOT gamma", "BNF boolean operators"],
    ["title:alpha", "BNF column filter"],
    ["{title body}:alpha", "BNF multi-column filter"],
    ["-title:alpha", "BNF excluded-column filter"],
    ["^alpha", "BNF initial-token marker"],
    ['alpha" OR beta', "quote breakout attempt"],
    ["alpha' AND beta", "apostrophe"],
  ])("literalizes %s safely through a real FTS5 MATCH (%s)", (raw) => {
    _setJiebaForTest(null);
    const db = createFtsDatabase(["alpha beta", "content alpha", "unrelated"]);

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

  it("prevents operator text from recovering raw FTS5 semantics", () => {
    _setJiebaForTest(null);
    const db = createFtsDatabase([
      "alpha only",
      "beta only",
      "alpha beta",
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

  it("can recall a literal uppercase FTS5 operator word", () => {
    _setJiebaForTest(null);
    const db = createFtsDatabase([
      "AND is a conjunction",
      "unrelated document",
    ]);

    try {
      expect(searchRowIds(db, "AND")).toEqual([1]);
    } finally {
      db.close();
    }
  });

  it("preserves ordinary lowercase English recall", () => {
    _setJiebaForTest(null);
    const db = createFtsDatabase([
      "research and development",
      "meet near the station",
      "unrelated",
    ]);

    try {
      expect(searchRowIds(db, "and")).toEqual([1]);
      expect(searchRowIds(db, "near")).toEqual([2]);
    } finally {
      db.close();
    }
  });

  it("preserves normal Chinese recall through jieba tokens", () => {
    _setJiebaForTest({
      cutForSearch: () => ["北京", "烤鸭", "北京烤鸭"],
    });
    const db = createFtsDatabase(["北京 烤鸭 北京烤鸭", "上海 小笼包"]);

    try {
      expect(searchRowIds(db, "北京烤鸭")).toEqual([1]);
    } finally {
      db.close();
    }
  });

  it("executes a query through the installed tokenizer path", () => {
    _resetJiebaForTest();
    const db = createFtsDatabase(["北京烤鸭 TypeScript", "上海小笼包"]);

    try {
      const query = buildFtsQuery("北京烤鸭 AND TypeScript");
      expect(query).toMatch(SAFE_LITERAL_QUERY);
      expect(() =>
        db.prepare("SELECT rowid FROM docs WHERE docs MATCH ?").all(query),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("keeps fallback recall results for benign English and Chinese queries", () => {
    _setJiebaForTest(null);
    const db = createFtsDatabase([
      "alpha beta project",
      "research and development",
      "android origin nearby",
      "中文AND测试",
      "北京 烤鸭",
      "unrelated",
    ]);
    const benignQueries = [
      "alpha beta",
      "research and development",
      "android origin nearby",
      "中文AND测试",
      "北京 烤鸭",
    ];

    try {
      for (const raw of benignQueries) {
        const before = searchQueryRowIds(db, buildLegacyFallbackQuery(raw));
        const after = searchRowIds(db, raw);
        expect(after, raw).toEqual(before);
      }
    } finally {
      db.close();
    }
  });

  it("keeps a quantified Recall@1 baseline on a fixed micro-corpus", () => {
    _setJiebaForTest(null);
    const db = createFtsDatabase([
      "alpha beta project planning", // expected for alpha beta project
      "alpha only status update",
      "北京烤鸭 restaurant", // expected for 北京烤鸭 fallback token
      "AND is a conjunction in documentation", // expected for AND
      "TypeScript sqlite memory plugin", // expected for TypeScript sqlite
      "unrelated travel note",
    ]);
    const cases = [
      { query: "alpha beta project", expected: [1] },
      { query: "北京烤鸭", expected: [3] },
      { query: "AND", expected: [4] },
      { query: "TypeScript sqlite", expected: [5] },
    ];

    try {
      const scores = cases.map(({ query, expected }) => {
        const actual = searchTopRowIds(db, query, 1);
        return recallAtK(actual, expected);
      });

      expect(scores).toEqual([1, 1, 1, 1]);
      expect(scores.reduce((sum, score) => sum + score, 0) / scores.length)
        .toBe(1);
    } finally {
      db.close();
    }
  });

  it.each(["", "   ", `"'()***`, "！@#￥%……&*（）"])(
    "returns no query when no searchable token remains: %j",
    (raw) => {
      _setJiebaForTest(null);

      expect(buildFtsQuery(raw)).toBeNull();
    },
  );
});
