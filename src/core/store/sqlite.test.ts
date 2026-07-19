import { afterEach, beforeEach, describe, expect, it } from "vitest";

// node:sqlite gives us a real in-memory FTS5 virtual table for integration
// tests — cross-platform (no system sqlite3 CLI dependency), and exercises the
// actual SQLite MATCH parser the production code relies on.
import { DatabaseSync } from "node:sqlite";

import {
  buildFtsQuery,
  _resetJiebaForTest,
  _setJiebaForTest,
} from "./sqlite.js";

// Keep jieba singleton state independent across tests.
afterEach(() => {
  _resetJiebaForTest();
});

describe("buildFtsQuery — FTS5 operator sanitization (issue #160)", () => {
  describe("regex fallback path (jieba disabled)", () => {
    beforeEach(() => {
      _setJiebaForTest(null);
    });

    it("strips uppercase FTS5 operators", () => {
      const q = buildFtsQuery("alpha AND beta OR gamma NOT delta NEAR epsilon");
      expect(q).not.toMatch(/"(?:AND|OR|NOT|NEAR)"/);
      expect(q).toBe('"alpha" OR "beta" OR "gamma" OR "delta" OR "epsilon"');
    });

    it("strips lowercase / mixed-case operators", () => {
      // Operators are stripped regardless of case (compared via toUpperCase).
      const q = buildFtsQuery("alpha and beta Or gamma");
      expect(q).toBe('"alpha" OR "beta" OR "gamma"');
    });

    it("strips full-width operator variants via NFKC", () => {
      // ＡＮＤ = full-width AND (U+FF21 U+FF2E U+FF24) — must collapse to AND
      // and be stripped, otherwise it bypasses the ASCII operator set.
      const q = buildFtsQuery("alpha ＡＮＤ beta");
      expect(q).toBe('"alpha" OR "beta"');
    });

    it("does NOT strip operator substrings embedded in normal words", () => {
      const q = buildFtsQuery("android orange notebook scotland nearshore");
      expect(q).toContain('"android"');
      expect(q).toContain('"orange"');
      expect(q).toContain('"notebook"');
      expect(q).toContain('"scotland"');
      expect(q).toContain('"nearshore"');
    });

    it("drops FTS5 structural syntax chars (* \" ( ) : ^)", () => {
      const q = buildFtsQuery('foo* "bar" (baz) content:qux ^x');
      expect(q).toBe('"foo" OR "bar" OR "baz" OR "content" OR "qux" OR "x"');
    });

    it("handles NEAR(...) function syntax by keeping inner terms", () => {
      // NEAR(alpha beta, 5) → operators/syntax stripped, alpha/beta preserved.
      const q = buildFtsQuery("NEAR(alpha beta, 5)");
      expect(q).toContain('"alpha"');
      expect(q).toContain('"beta"');
      expect(q).not.toMatch(/NEAR/);
    });

    it("returns null when input reduces to operators only", () => {
      expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
    });

    it("returns null for empty / symbol-only input", () => {
      expect(buildFtsQuery("")).toBeNull();
      expect(buildFtsQuery("   * ( ) : ")).toBeNull();
    });
  });

  describe("jieba path", () => {
    it("preserves normal Chinese segmentation (regression)", () => {
      // Real jieba — keep the assertion loose: segmentation output must be a
      // non-empty OR-join of quoted tokens, unchanged by sanitization.
      const q = buildFtsQuery("用户喜欢编程");
      expect(q).not.toBeNull();
      expect(q!.startsWith('"')).toBe(true);
      expect(q!.includes(" OR ")).toBe(true);
      // No quoted operator token should leak into the output.
      expect(q).not.toMatch(/"(?:AND|OR|NOT|NEAR)"/);
    });

    it("strips operators and cleans dirty tokens from jieba output", () => {
      // Stub jieba to emit a token list containing an operator and a dirty
      // token carrying FTS5 syntax — both must be neutralised.
      _setJiebaForTest({
        cutForSearch: () => ["用户", "AND", "NEAR(beta", "编程"],
      } as never);
      const q = buildFtsQuery("ignored-by-stub");
      expect(q).toBe('"用户" OR "beta" OR "编程"');
    });
  });
});

describe("buildFtsQuery — real FTS5 MATCH integration (node:sqlite)", () => {
  // Force the fallback path so buildFtsQuery output is deterministic and
  // independent of jieba's English tokenisation quirks.
  beforeEach(() => {
    _setJiebaForTest(null);
  });

  // ponytail: in-memory FTS5 via node:sqlite — cross-platform, no system CLI.
  function withFts5Fixture(
    docs: string[],
    run: (search: (q: string) => Set<string>) => void,
  ): void {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
    const insert = db.prepare("INSERT INTO t(content) VALUES (?)");
    for (const d of docs) insert.run(d);
    const search = (matchExpr: string): Set<string> => {
      const rows = db
        .prepare("SELECT content FROM t WHERE content MATCH ? ORDER BY rank")
        .all(matchExpr) as Array<{ content: string }>;
      return new Set(rows.map((r) => r.content));
    };
    try {
      run(search);
    } finally {
      db.close();
    }
  }

  const DOCS = ["foo bar", "foo", "bar", "foo bar baz", "unrelated"];

  it("AND is neutralised — same recall as plain OR", () => {
    withFts5Fixture(DOCS, (search) => {
      // "foo AND bar" must NOT narrow to docs containing both; it behaves like
      // "foo OR bar" because the operator is stripped before MATCH.
      const withOp = search(buildFtsQuery("foo AND bar")!);
      const without = search(buildFtsQuery("foo bar")!);
      expect(withOp).toEqual(without);
      expect(without.size).toBe(4); // all docs containing foo or bar
    });
  });

  it("NOT is neutralised — does not exclude matches", () => {
    withFts5Fixture(DOCS, (search) => {
      // "foo NOT bar" must not drop bar-containing docs.
      const hits = search(buildFtsQuery("foo NOT bar")!);
      expect(hits.has("bar")).toBe(true);
      expect(hits).toEqual(search(buildFtsQuery("foo bar")!));
    });
  });

  it("benign query recall is preserved (no regression)", () => {
    withFts5Fixture(DOCS, (search) => {
      const hits = search(buildFtsQuery("foo bar")!);
      expect(hits.size).toBe(4);
      expect(hits.has("unrelated")).toBe(false);
    });
  });

  it("adversarial input never throws and yields a valid MATCH expr", () => {
    withFts5Fixture(DOCS, (search) => {
      const cases = [
        'foo" OR "1',
        "*",
        ")(",
        "content:foo",
        "ＡＮＤ",
        "a^b",
        "NEAR(x y,5)",
      ];
      for (const c of cases) {
        const q = buildFtsQuery(c);
        if (q === null) continue; // reduced to nothing — fine
        expect(() => search(q)).not.toThrow();
      }
    });
  });
});
