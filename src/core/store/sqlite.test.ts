import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import { _resetJiebaForTest, _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

const require = createRequire(import.meta.url);

function expectFallbackQuery(raw: string, expected: string | null): void {
  _setJiebaForTest(null);
  expect(buildFtsQuery(raw)).toBe(expected);
}

function legacyFallbackFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];

  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

function queryFtsMatches(query: string): string[] {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, content);
      INSERT INTO docs (id, content) VALUES
        ('travel', 'travel plan api_v2 itinerary budget'),
        ('typescript', 'typescript sqlite fts5 search builder'),
        ('memory', 'agent memory recall ranking alpha123'),
        ('recipe', 'sourdough starter bread recipe'),
        ('mixed', 'travel sqlite memory alpha123 api_v2');
    `);

    return (
      db
        .prepare("SELECT id FROM docs WHERE docs MATCH ? ORDER BY id")
        .all(query) as Array<{ id: string }>
    ).map((row) => row.id);
  } finally {
    db.close();
  }
}

function expectWhitelistedMatchExpression(query: string): void {
  expect(query).toMatch(/^"[\p{L}\p{N}_]+"(?: OR "[\p{L}\p{N}_]+")*$/u);
}

describe("buildFtsQuery", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("removes FTS5 operators before fallback tokenization", () => {
    expectFallbackQuery(
      "alpha AND beta or gamma NOT delta NEAR epsilon",
      '"alpha" OR "beta" OR "gamma" OR "delta" OR "epsilon"',
    );
  });

  it.each([
    ["AND"],
    ["and"],
    ["And"],
    ["OR"],
    ["or"],
    ["Or"],
    ["NOT"],
    ["not"],
    ["Not"],
    ["NEAR"],
    ["near"],
    ["Near"],
  ])("removes the %s FTS5 operator as a standalone token", (operator) => {
    expectFallbackQuery(`alpha ${operator} beta`, '"alpha" OR "beta"');
  });

  it("does not strip operator substrings inside normal words", () => {
    expectFallbackQuery(
      "candy origin notepad nearest ordinary android",
      '"candy" OR "origin" OR "notepad" OR "nearest" OR "ordinary" OR "android"',
    );
  });

  it("removes FTS5 syntax characters without dropping normal fallback terms", () => {
    expectFallbackQuery(
      'title:alpha (beta) "gamma" delta*',
      '"title" OR "alpha" OR "beta" OR "gamma" OR "delta"',
    );
  });

  it("neutralizes common FTS5 query grammar constructs", () => {
    expectFallbackQuery(
      '^title:alpha {body}:beta -{archived}:gamma NEAR(delta epsilon, 5) "exact phrase" tag*',
      '"title" OR "alpha" OR "body" OR "beta" OR "archived" OR "gamma" OR "delta" OR "epsilon" OR "5" OR "exact" OR "phrase" OR "tag"',
    );
  });

  it("builds a whitelist-only MATCH expression from hostile fallback input", () => {
    _setJiebaForTest(null);

    const query = buildFtsQuery(
      '^title:alpha {body}:beta OR "quoted phrase" NOT gamma NEAR(delta epsilon, 5) tag*',
    );

    expect(query).not.toBeNull();
    expectWhitelistedMatchExpression(query!);
  });

  it.each([
    [""],
    ["   \t\n"],
    ['AND OR NOT NEAR "()" *'],
    ['"\'()[]{}^*:*-+,.!?'],
  ])("returns null when fallback input has no searchable terms: %j", (raw) => {
    expectFallbackQuery(raw, null);
  });

  it("preserves normal mixed-language fallback search terms", () => {
    expectFallbackQuery(
      "旅行 plan API_v2 alpha123",
      '"旅行" OR "plan" OR "API_v2" OR "alpha123"',
    );
  });

  it("keeps fallback query output unchanged for normal user searches", () => {
    _setJiebaForTest(null);

    const normalQueries = [
      "travel plan API_v2",
      "TypeScript sqlite fts5",
      "agent memory recall alpha123",
      "sourdough starter recipe",
      "multi word search 2026",
    ];

    for (const query of normalQueries) {
      expect(buildFtsQuery(query)).toBe(legacyFallbackFtsQuery(query));
    }
  });

  it("keeps fallback FTS5 recall unchanged for normal user searches", () => {
    _setJiebaForTest(null);

    const normalQueries = [
      "travel plan API_v2",
      "TypeScript sqlite",
      "agent memory alpha123",
      "sourdough recipe",
      "travel memory api_v2",
    ];

    for (const raw of normalQueries) {
      const legacyQuery = legacyFallbackFtsQuery(raw);
      const sanitizedQuery = buildFtsQuery(raw);
      expect(sanitizedQuery).toBe(legacyQuery);
      expect(sanitizedQuery).not.toBeNull();
      expect(queryFtsMatches(sanitizedQuery!)).toEqual(queryFtsMatches(legacyQuery!));
    }
  });

  it("sanitizes raw text before jieba tokenization", () => {
    _setJiebaForTest({
      cutForSearch(text: string) {
        expect(text).toBe("alpha   beta   gamma ");
        return text.match(/[\p{L}\p{N}_]+/gu) ?? [];
      },
    });

    expect(buildFtsQuery("alpha AND beta NEAR(gamma)")).toBe('"alpha" OR "beta" OR "gamma"');
  });

  it("removes FTS5 operators and syntax before jieba tokenization", () => {
    _setJiebaForTest({
      cutForSearch(text: string) {
        expect(text).not.toMatch(/\b(?:AND|OR|NOT|NEAR)\b/iu);
        expect(text).not.toMatch(/["'()[\]{}^*:]/u);
        return text.match(/[\p{L}\p{N}_]+/gu) ?? [];
      },
    });

    expect(buildFtsQuery('^alpha AND "beta" OR (gamma) NOT {delta}:epsilon NEAR(zeta) eta*')).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta" OR "epsilon" OR "zeta" OR "eta"',
    );
  });

  it("filters FTS5 operator tokens returned by jieba", () => {
    _setJiebaForTest({
      cutForSearch() {
        return ["alpha", "AND", "or", "beta", "NEAR"];
      },
    });

    expect(buildFtsQuery("alpha AND beta")).toBe('"alpha" OR "beta"');
  });

  it("deduplicates jieba tokens after sanitization", () => {
    _setJiebaForTest({
      cutForSearch() {
        return ["alpha", "alpha", "AND", "beta", "beta"];
      },
    });

    expect(buildFtsQuery("alpha AND beta")).toBe('"alpha" OR "beta"');
  });
});
