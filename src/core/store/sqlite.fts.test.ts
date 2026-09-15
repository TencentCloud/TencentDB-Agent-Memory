/**
 * FTS5 Tests
 *
 * Tests for FTS5 search sanitization and query building.
 *
 * Uses better-sqlite3 which supports FTS5 extension for real integration tests.
 * FTS5 allows accurate recall and BM25 ranking verification.
 *
 * Test coverage:
 * 1. Pure functions: sanitizeFtsInput, buildFtsQuery, bm25RankToScore
 * 2. End-to-end pipeline: sanitizeFtsInput → buildFtsQuery
 * 3. FTS5 integration tests (real FTS5 with better-sqlite3)
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  buildFtsQuery,
  sanitizeFtsInput,
  bm25RankToScore,
  _resetJiebaForTest,
  _setJiebaForTest,
} from "./sqlite.js";

/**
 * Create an in-memory FTS5 table for testing.
 * Uses better-sqlite3 which supports FTS5 extension.
 */
function createFts5TestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id,
      content
    );
  `);
  return db;
}

/**
 * FTS5 Integration Tests (Real FTS5 with better-sqlite3)
 *
 * These tests use real FTS5 tables to verify:
 * 1. Basic search functionality
 * 2. Recall equivalence between sanitized and non-sanitized queries
 * 3. Security: injection attempts are safely neutralized
 */
describe("FTS5 Integration: Basic Search", () => {
  let db: ReturnType<typeof createFts5TestDb>;

  beforeEach(() => {
    _resetJiebaForTest();
    _setJiebaForTest(null);
    db = createFts5TestDb();

    // Insert test data
    db.exec(`
      INSERT INTO memory_fts (id, content) VALUES
        (1, 'TypeScript is a typed superset of JavaScript'),
        (2, 'Python is a popular programming language'),
        (3, 'JavaScript runs in the browser'),
        (4, 'Rust is a systems programming language'),
        (5, 'Go is efficient and concurrent');
    `);
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("finds records matching single token", () => {
    const ftsQuery = buildFtsQuery("TypeScript");
    const results = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(ftsQuery) as { id: number }[];

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1);
  });

  it("finds records matching multiple tokens via OR", () => {
    const ftsQuery = buildFtsQuery("TypeScript Python");
    const results = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(ftsQuery) as { id: number }[];

    expect(results.length).toBeGreaterThanOrEqual(2);
    const ids = results.map(r => r.id).sort();
    expect(ids).toContain(1); // TypeScript
    expect(ids).toContain(2); // Python
  });

  it("ranks results by BM25 relevance", () => {
    const ftsQuery = buildFtsQuery("programming");
    const results = db.prepare(`
      SELECT id, bm25(memory_fts) as rank
      FROM memory_fts
      WHERE memory_fts MATCH ?
      ORDER BY rank
    `).all(ftsQuery) as { id: number; rank: number }[];

    // More relevant results should have lower (more negative) BM25 rank
    expect(results.length).toBeGreaterThan(0);
    // Verify results are sorted by rank
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].rank).toBeLessThanOrEqual(results[i].rank);
    }
  });
});

describe("FTS5 Integration: Sanitization vs Recall", () => {
  let db: ReturnType<typeof createFts5TestDb>;

  beforeEach(() => {
    _resetJiebaForTest();
    _setJiebaForTest(null);
    db = createFts5TestDb();

    // Insert test data
    db.exec(`
      INSERT INTO memory_fts (id, content) VALUES
        (1, 'Python programming with async'),
        (2, 'Python scripting automation'),
        (3, 'JavaScript async promises'),
        (4, 'TypeScript async functions');
    `);
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("sanitized query 'A AND B' produces same results as 'A B' OR query", () => {
    // Original query with AND
    const originalQuery = "Python AND async";
    const sanitizedQuery = "Python async";

    // Build FTS queries
    const originalFts = buildFtsQuery(originalQuery);
    const sanitizedFts = buildFtsQuery(sanitizedQuery);

    // Both should produce valid OR queries
    expect(originalFts).toBeTruthy();
    expect(sanitizedFts).toBeTruthy();
    expect(originalFts).toBe(sanitizedFts);

    // Query results should match
    const originalResults = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(originalFts!) as { id: number }[];
    const sanitizedResults = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(sanitizedFts!) as { id: number }[];

    const originalIds = originalResults.map(r => r.id).sort();
    const sanitizedIds = sanitizedResults.map(r => r.id).sort();

    expect(sanitizedIds).toEqual(originalIds);
  });

  it("sanitized query 'A OR B' produces correct OR results", () => {
    const query = "Python OR JavaScript";
    const ftsQuery = buildFtsQuery(query);
    const results = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(ftsQuery) as { id: number }[];

    const ids = results.map(r => r.id).sort();
    // Should find Python docs (1, 2) and JavaScript docs (3)
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
    expect(ids).not.toContain(4); // TypeScript (no Python/JavaScript)
  });

  it("parentheses injection does not break search", () => {
    const maliciousQuery = "(Python) AND (async)";
    const ftsQuery = buildFtsQuery(maliciousQuery);

    expect(ftsQuery).toBeTruthy();
    const results = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(ftsQuery!) as { id: number }[];

    // Should still find Python async docs
    expect(results.length).toBeGreaterThan(0);
  });

  it("quoted injection does not break search", () => {
    const maliciousQuery = '"Python" OR "hacked"';
    const ftsQuery = buildFtsQuery(maliciousQuery);

    expect(ftsQuery).toBeTruthy();
    const results = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(ftsQuery!) as { id: number }[];

    // Should only find Python docs, not "hacked"
    const ids = results.map(r => r.id);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
  });

  it("wildcard injection is safely handled", () => {
    const maliciousQuery = "Python*";
    const ftsQuery = buildFtsQuery(maliciousQuery);

    // Wildcard should be stripped, returning just "Python"
    expect(ftsQuery).toBe('"Python"');

    const results = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(ftsQuery!) as { id: number }[];
    expect(results.length).toBe(2); // Python docs
  });

  it("SQL comment injection is safely handled", () => {
    const maliciousQuery = "Python -- admin";
    const ftsQuery = buildFtsQuery(maliciousQuery);

    // The -- is replaced with space, so "admin" becomes a normal token
    // This is acceptable: SQL comment injection is neutralized, search still works
    expect(ftsQuery).toBe('"Python" OR "admin"');
    const results = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(ftsQuery!) as { id: number }[];
    // Still finds Python docs, "admin" just won't match anything
    expect(results.some(r => r.id === 1 || r.id === 2)).toBe(true);
  });
});

describe("FTS5 Integration: Chinese Text Search", () => {
  let db: ReturnType<typeof createFts5TestDb>;

  beforeEach(() => {
    _resetJiebaForTest();
    _setJiebaForTest(null);
    db = createFts5TestDb();

    // Insert Chinese test data
    db.exec(`
      INSERT INTO memory_fts (id, content) VALUES
        (1, 'Python 编程语言'),
        (2, 'JavaScript 前端开发'),
        (3, '机器学习 算法'),
        (4, '深度学习 神经网络');
    `);
  });

  afterEach(() => {
    if (db) db.close();
  });

  it("handles Chinese text after sanitization", () => {
    const query = "Python 编程";
    const ftsQuery = buildFtsQuery(query);

    expect(ftsQuery).toBeTruthy();
    const results = db.prepare(`SELECT id FROM memory_fts WHERE memory_fts MATCH ?`).all(ftsQuery!) as { id: number }[];

    // Should find the Python 编程 doc
    expect(results.some(r => r.id === 1)).toBe(true);
  });
});

/**
 * BM25 Score Conversion Tests (Pure Function - Always Runs)
 *
 * These tests verify the BM25 score conversion logic.
 * They do NOT require FTS5 and run in all environments.
 */
describe("BM25 Score Conversion (Pure Function)", () => {
  it("converts BM25 rank to 0-1 score correctly", () => {
    // BM25 rank: negative = more relevant, positive = less relevant
    // Score: 0-1, higher = more relevant

    // Very relevant (negative rank)
    expect(bm25RankToScore(-5)).toBeGreaterThan(0.8);
    expect(bm25RankToScore(-1)).toBeGreaterThan(0.4);

    // Less relevant (positive rank)
    expect(bm25RankToScore(0)).toBe(1);
    expect(bm25RankToScore(1)).toBeLessThan(0.6);
    expect(bm25RankToScore(5)).toBeLessThan(0.2);
  });

  it("handles edge cases in BM25 score conversion", () => {
    // Infinity
    expect(Number.isFinite(bm25RankToScore(Infinity))).toBe(true);
    expect(Number.isFinite(bm25RankToScore(-Infinity))).toBe(true);

    // NaN
    expect(Number.isFinite(bm25RankToScore(NaN))).toBe(true);

    // Zero
    expect(bm25RankToScore(0)).toBe(1);
  });
});

/**
 * Build FTS Query Integration Tests (Pure Function - Always Runs)
 *
 * These tests verify buildFtsQuery behavior with various inputs.
 * They do NOT require FTS5 and run in all environments.
 */
describe("buildFtsQuery Integration (Pure Function)", () => {
  beforeEach(() => {
    _resetJiebaForTest();
    _setJiebaForTest(null);
  });

  it("handles single token", () => {
    const result = buildFtsQuery("TypeScript");
    expect(result).toBe('"TypeScript"');
  });

  it("handles multiple tokens with OR", () => {
    const result = buildFtsQuery("TypeScript Python");
    expect(result).toBe('"TypeScript" OR "Python"');
  });

  it("handles Chinese tokens", () => {
    const result = buildFtsQuery("用户");
    expect(result).toBe('"用户"');
  });

  it("handles mixed language tokens", () => {
    const result = buildFtsQuery("Python 编程");
    expect(result).toBe('"Python" OR "编程"');
  });

  it("handles empty input", () => {
    expect(buildFtsQuery("")).toBe(null);
    expect(buildFtsQuery("   ")).toBe(null);
  });

  it("handles input with only operators", () => {
    expect(buildFtsQuery("AND OR NOT")).toBe(null);
    expect(buildFtsQuery("AND Python")).toBe('"Python"');
  });
});

/**
 * Sanitize FTS Input Integration Tests (Pure Function - Always Runs)
 *
 * These tests verify sanitizeFtsInput behavior with various inputs.
 * They do NOT require FTS5 and run in all environments.
 */
describe("sanitizeFtsInput Integration (Pure Function)", () => {
  beforeEach(() => {
    _resetJiebaForTest();
    _setJiebaForTest(null);
  });

  it("handles empty input", () => {
    expect(sanitizeFtsInput("")).toBe("");
    expect(sanitizeFtsInput("   ")).toBe("");
  });

  it("preserves normal text", () => {
    expect(sanitizeFtsInput("Hello World")).toBe("Hello World");
    expect(sanitizeFtsInput("TypeScript")).toBe("TypeScript");
  });

  it("removes FTS5 operators", () => {
    expect(sanitizeFtsInput("Hello AND World")).toBe("Hello World");
    expect(sanitizeFtsInput("Test OR Query")).toBe("Test Query");
    expect(sanitizeFtsInput("Exclude NOT Term")).toBe("Exclude Term");
    expect(sanitizeFtsInput("Hello NEAR World")).toBe("Hello World");
  });

  it("removes quotes and parentheses", () => {
    expect(sanitizeFtsInput('"quoted"')).toBe("quoted");
    expect(sanitizeFtsInput("(grouped)")).toBe("grouped");
  });

  it("removes wildcards", () => {
    expect(sanitizeFtsInput("term*")).toBe("term");
    expect(sanitizeFtsInput("prefix*")).toBe("prefix");
  });

  it("treats 'near' in natural text as FTS5 operator (security)", () => {
    // "near" standalone is a FTS5 operator and should be stripped
    expect(sanitizeFtsInput("near match")).toBe("match");
    expect(sanitizeFtsInput("hello near world")).toBe("hello world");
  });

  it("handles SQL comment injection", () => {
    expect(sanitizeFtsInput("admin'; --")).toBe("admin");
    expect(sanitizeFtsInput("DROP--")).toBe("DROP");
  });

  it("handles column filter injection", () => {
    expect(sanitizeFtsInput("content:secret")).toBe("content secret");
    expect(sanitizeFtsInput("type:admin")).toBe("type admin");
  });

  it("handles comparison operators", () => {
    expect(sanitizeFtsInput("a < b")).toBe("a b");
    expect(sanitizeFtsInput("x > y")).toBe("x y");
  });

  it("enforces lexical whitelist - removes non-alphanumeric characters", () => {
    // Only letters, numbers, underscores, hyphens, CJK, and whitespace are allowed
    expect(sanitizeFtsInput("hello@world.com")).toBe("hello world com");
    expect(sanitizeFtsInput("file.txt")).toBe("file txt");
    expect(sanitizeFtsInput("price: $100")).toBe("price 100");
    expect(sanitizeFtsInput("item[0]")).toBe("item 0");
    expect(sanitizeFtsInput("func(a, b)")).toBe("func a b");
  });

  it("allows underscores and hyphens in identifiers", () => {
    // Underscores and hyphens are preserved
    expect(sanitizeFtsInput("my_variable")).toBe("my_variable");
    expect(sanitizeFtsInput("my-variable")).toBe("my-variable");
  });

  it("normalizes whitespace", () => {
    expect(sanitizeFtsInput("  hello   world  ")).toBe("hello world");
    expect(sanitizeFtsInput("hello\t\nworld")).toBe("hello world");
  });

  it("preserves Chinese characters", () => {
    expect(sanitizeFtsInput("用户编程")).toBe("用户编程");
    expect(sanitizeFtsInput("Python 和 JavaScript")).toBe("Python 和 JavaScript");
  });

  it("handles complex injection attempts", () => {
    // Combined attack patterns - OR should be stripped, leaving only tokens
    expect(sanitizeFtsInput('term" OR "x" = "x')).toBe("term x x");
    expect(sanitizeFtsInput("(admin) OR (1=1)")).toBe("admin 1 1");
  });
});

/**
 * End-to-End Sanitization + BuildQuery Tests
 *
 * These tests verify the full pipeline: sanitizeFtsInput → buildFtsQuery
 * They do NOT require FTS5 and run in all environments.
 */
describe("End-to-End: Sanitize + BuildQuery Pipeline", () => {
  beforeEach(() => {
    _resetJiebaForTest();
    _setJiebaForTest(null);
  });

  it("normal query passes through unchanged", () => {
    const query = "TypeScript Python";
    const sanitized = sanitizeFtsInput(query);
    const ftsQuery = buildFtsQuery(query);

    expect(sanitized).toBe("TypeScript Python");
    expect(ftsQuery).toBe('"TypeScript" OR "Python"');
  });

  it("query with AND operator is safely processed", () => {
    const query = "TypeScript AND Python";
    const sanitized = sanitizeFtsInput(query);
    const ftsQuery = buildFtsQuery(query);

    expect(sanitized).toBe("TypeScript Python");
    expect(ftsQuery).toBe('"TypeScript" OR "Python"');
  });

  it("query with parentheses is safely processed", () => {
    const query = "(TypeScript) AND (Python)";
    const sanitized = sanitizeFtsInput(query);
    const ftsQuery = buildFtsQuery(query);

    expect(sanitized).toBe("TypeScript Python");
    expect(ftsQuery).toBe('"TypeScript" OR "Python"');
  });

  it("query with quotes is safely processed", () => {
    const query = '"TypeScript" AND "Python"';
    const sanitized = sanitizeFtsInput(query);
    const ftsQuery = buildFtsQuery(query);

    expect(sanitized).toBe("TypeScript Python");
    expect(ftsQuery).toBe('"TypeScript" OR "Python"');
  });

  it("injection attempt is safely neutralized", () => {
    const attack = 'admin" OR "1=1" --';
    const sanitized = sanitizeFtsInput(attack);
    const ftsQuery = buildFtsQuery(attack);

    // Original input OR should be stripped by sanitizeFtsInput
    // FTS query will contain "OR" as FTS5 syntax, but that's safe
    expect(sanitized).not.toContain(" OR ");
    expect(sanitized).not.toContain("--");

    // The FTS query will be safe: '"admin" OR "1" OR "1"'
    // It's normal FTS5 syntax, not injection
  });

  it("mixed language with operators is safely processed", () => {
    const query = "Python AND 编程";
    const sanitized = sanitizeFtsInput(query);
    const ftsQuery = buildFtsQuery(query);

    expect(sanitized).toBe("Python 编程");
    expect(ftsQuery).toBe('"Python" OR "编程"');
  });
});
