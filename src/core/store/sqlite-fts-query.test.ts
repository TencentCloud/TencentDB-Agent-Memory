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
  _resetJiebaForTest();
});

describe("sanitizeFts5Input", () => {
  it("removes standalone uppercase FTS5 boolean and proximity operators", () => {
    const sanitized = sanitizeFts5Input(
      "alpha AND beta OR NOT gamma NEAR(delta)",
    );

    expect(sanitized.replace(/\s+/g, " ").trim()).toBe(
      "alpha beta gamma (delta)",
    );
  });

  it("preserves non-operator words and lowercase prose for recall quality", () => {
    const input =
      "and or not near And Or Not Near android origin notable nearby 中文AND测试";

    expect(sanitizeFts5Input(input)).toBe(input);
  });
});

describe("buildFtsQuery sanitization", () => {
  it("sanitizes operators before fallback tokenization", () => {
    _setJiebaForTest(null);

    expect(buildFtsQuery("alpha AND beta or gamma")).toBe(
      '"alpha" OR "beta" OR "or" OR "gamma"',
    );
    expect(buildFtsQuery("中文AND测试")).toBe('"中文AND测试"');
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

  it("escapes hostile tokenizer output before it crosses MATCH", () => {
    _setJiebaForTest({
      cutForSearch: () => [
        'alpha" OR beta',
        "gamma*",
        "NEAR(alpha beta)",
        "NOT",
        "(delta)",
      ],
    });
    const db = createFtsIndex([
      "alpha OR beta",
      "gamma",
      "delta",
      "unrelated",
    ]);

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
});

describe("buildFtsQuery real FTS5 execution", () => {
  it.each([
    ['alpha" OR beta', "double quote and OR"],
    ["alpha' AND beta", "apostrophe and AND"],
    ["(alpha) NOT beta", "parentheses and NOT"],
    ["NEAR(alpha beta, 5)", "NEAR expression"],
    ["alpha*", "prefix operator"],
    ["content:alpha", "column filter"],
    ["alpha ^ beta", "caret syntax"],
    ['alpha OR "" OR * beta', "combined syntax"],
  ])("keeps %s inside quoted literal terms (%s)", (raw) => {
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

  it("prevents operator text from recovering raw FTS5 semantics", () => {
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

  it("preserves lowercase operator words used as ordinary search terms", () => {
    _setJiebaForTest(null);
    const db = createFtsIndex([
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

  it("keeps pre-sanitizer recall for benign fallback queries", () => {
    _setJiebaForTest(null);
    const db = createFtsIndex([
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

  it("preserves jieba search tokens for normal Chinese recall", () => {
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

  it.each(["", "   ", "\"'()***", "！@#￥%……&*（）", "AND OR NOT NEAR"])(
    "returns null when no searchable token remains: %j",
    (raw) => {
      _setJiebaForTest(null);
      expect(buildFtsQuery(raw)).toBeNull();
    },
  );
});
