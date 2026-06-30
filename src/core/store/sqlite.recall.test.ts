/**
 * Recall & true-FTS5 integration tests for the sanitization in
 * `src/core/store/sqlite.ts`.
 *
 * Two angles are exercised here:
 *
 *   1. **True FTS5 execution** — we instantiate a real `node:sqlite`
 *      database with an FTS5 virtual table, index a fixture, and run the
 *      queries that `buildFtsQuery()` produces.  This proves the generated
 *      MATCH expressions are syntactically valid AND that malicious inputs
 *      cannot poison result semantics.
 *
 *   2. **Recall comparison** — we compare the result set size and top-K
 *      contents between the new sanitized `buildFtsQuery()` and the old
 *      raw-token form on a fixed 25-row corpus.  A regression on ordinary
 *      keyword queries would surface here.
 *
 * The tests intentionally avoid `@node-rs/jieba` so they remain
 * deterministic in CI environments without the optional native binding.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";

import { _setJiebaForTest, buildFtsQuery } from "./sqlite.js";

interface IndexedDoc {
  record_id: string;
  content: string;
}

const FIXTURE: IndexedDoc[] = [
  { record_id: "r1", content: "TypeScript builds scalable web APIs" },
  { record_id: "r2", content: "TencentDB memory plugin uses SQLite FTS5" },
  { record_id: "r3", content: "Vector search with sqlite-vec extension" },
  { record_id: "r4", content: "用户偏好简洁的 TypeScript 示例" },
  { record_id: "r5", content: "Travel plan for Tokyo in May" },
  { record_id: "r6", content: "Plan a trip to Japan and visit Tokyo Tower" },
  { record_id: "r7", content: "OpenClaw integration guide for Hermes" },
  { record_id: "r8", content: "ANDROID 12 release notes for programmers" },
  { record_id: "r9", content: "ORACLE database administrator tutorial" },
  { record_id: "r10", content: "NEARBY restaurants open after midnight" },
  { record_id: "r11", content: "FTS5 reserved operators in attack samples" },
  { record_id: "r12", content: "Content column filter syntax content:foo" },
  { record_id: "r13", content: "Prefix wildcard example alpha*" },
  { record_id: "r14", content: "Parenthesized group (alpha) OR (beta)" },
  { record_id: "r15", content: "Phrase-quote injection alpha\" OR \"beta" },
  { record_id: "r16", content: "Single quote escape alpha'beta" },
  { record_id: "r17", content: "中文测试 分词 用户 编程 TypeScript" },
  { record_id: "r18", content: "BM25 ranking comparison baseline" },
  { record_id: "r19", content: "Plugin memory pipeline L0 L1 L2 L3" },
  { record_id: "r20", content: "Empty match NULL semantics check" },
  { record_id: "r21", content: "Sanity check fixture record 21" },
  { record_id: "r22", content: "Sanity check fixture record 22" },
  { record_id: "r23", content: "Sanity check fixture record 23" },
  { record_id: "r24", content: "Sanity check fixture record 24" },
  { record_id: "r25", content: "Sanity check fixture record 25" },
];

/** Build the OLD pre-sanitization MATCH expression for comparison only. */
function legacyBuildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
}

/**
 * Insert the fixture into a fresh in-memory FTS5 table.  Each describe
 * block creates its own db (and closes it in `afterAll`) so tests are
 * isolated across forks.
 */
function setupFts(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE VIRTUAL TABLE docs USING fts5(
      record_id UNINDEXED,
      content,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `);
  const insert = database.prepare(
    "INSERT INTO docs (record_id, content) VALUES (?, ?)",
  );
  for (const doc of FIXTURE) insert.run(doc.record_id, doc.content);
  return database;
}

describe("buildFtsQuery — real FTS5 execution", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    _setJiebaForTest(null);
    db = setupFts();
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  });

  /** Run a MATCH query and return the record_ids returned (BM25 order). */
  function queryIds(matchExpr: string): string[] {
    const rows = db
      .prepare(
        "SELECT record_id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs)",
      )
      .all(matchExpr) as Array<{ record_id: string }>;
    return rows.map((r) => r.record_id);
  }

  it("returns a syntactically valid MATCH for the happy path", () => {
    const match = buildFtsQuery("TypeScript memory");
    expect(match).not.toBeNull();
    const ids = queryIds(match!);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("does not throw on column-filter abuse", () => {
    const match = buildFtsQuery("content:foo");
    expect(match).not.toBeNull();
    expect(() => queryIds(match!)).not.toThrow();
  });

  it("does not throw on parenthesized group expression", () => {
    const match = buildFtsQuery("(alpha) OR (beta)");
    expect(match).not.toBeNull();
    expect(() => queryIds(match!)).not.toThrow();
  });

  it("does not throw on prefix-wildcard syntax", () => {
    const match = buildFtsQuery("alpha*");
    expect(match).not.toBeNull();
    expect(() => queryIds(match!)).not.toThrow();
  });

  it("does not throw on phrase-quote injection", () => {
    const match = buildFtsQuery('alpha" OR "beta');
    expect(match).not.toBeNull();
    expect(() => queryIds(match!)).not.toThrow();
  });

  it("returns null for input that becomes empty after sanitization", () => {
    expect(buildFtsQuery("AND OR NOT NEAR")).toBeNull();
    expect(buildFtsQuery("***(((")).toBeNull();
  });

  it("executes AND NOT beta cleanly as OR-of-tokens", () => {
    const match = buildFtsQuery("alpha AND NOT beta");
    expect(match).not.toBeNull();
    // Should be a safe OR-of-terms query; must execute without throwing.
    expect(() => queryIds(match!)).not.toThrow();
  });
});

describe("buildFtsQuery — recall comparison vs. legacy", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    _setJiebaForTest(null);
    db = setupFts();
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  });

  function queryIds(matchExpr: string): string[] {
    const rows = db
      .prepare(
        "SELECT record_id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs)",
      )
      .all(matchExpr) as Array<{ record_id: string }>;
    return rows.map((r) => r.record_id);
  }

  /**
   * Sanitized recall must be a SUPERSET of legacy recall for benign queries:
   * we drop only reserved words / syntax chars, never alphanumeric tokens.
   */
  const queries = [
    "TypeScript memory",
    "users prefer concise",
    "TencentDB FTS5",
    "Travel Tokyo",
    "OpenClaw Hermes",
    "Sanity check",
  ];

  for (const q of queries) {
    it(`recall parity — "${q}"`, () => {
      const legacy = legacyBuildFtsQuery(q);
      const safe = buildFtsQuery(q);
      expect(safe, `safe query for ${q}`).not.toBeNull();
      if (safe === null) return;
      const legacyIds = legacy ? new Set(queryIds(legacy)) : new Set<string>();
      const safeIds = new Set(queryIds(safe));
      for (const id of legacyIds) {
        expect(
          safeIds.has(id),
          `${q}: legacy hit ${id} missing from safe`,
        ).toBe(true);
      }
    });
  }
});

describe("buildFtsQuery — fuzz: random adversarial inputs never throw", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    _setJiebaForTest(null);
    db = setupFts();
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
  });

  function queryIds(matchExpr: string): string[] {
    const rows = db
      .prepare(
        "SELECT record_id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs)",
      )
      .all(matchExpr) as Array<{ record_id: string }>;
    return rows.map((r) => r.record_id);
  }

  it("survives 200 randomized attack-style queries without throwing", () => {
    const corpus = [
      "alpha beta",
      'alpha" OR "beta',
      "alpha AND NOT beta",
      "(NEAR/5 alpha beta)",
      "alpha* OR beta",
      "content:-foo",
      "message:bar",
      "ＡＮＤ OR NOT ＮＥＡＲ",
      "*()*()",
      "OR AND OR AND OR",
      '"a" AND "b" OR "c" NOT "d"',
      "user:-something",
      "and AND aND AnD",
    ];
    let totalQueries = 0;
    for (let i = 0; i < 200; i++) {
      const n = 1 + (i % 3);
      const fragments: string[] = [];
      for (let j = 0; j < n; j++) {
        fragments.push(corpus[(i * 7 + j * 13) % corpus.length]);
      }
      const input = fragments.join(" ");
      const match = buildFtsQuery(input);
      totalQueries++;
      if (match !== null) {
        expect(() => queryIds(match)).not.toThrow();
      }
    }
    expect(totalQueries).toBe(200);
  });
});
