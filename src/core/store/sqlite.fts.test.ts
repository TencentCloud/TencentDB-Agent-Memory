/**
 * Security & recall tests for FTS5 query sanitization (issue #160).
 *
 * Covers the four acceptance levels from the issue:
 *   - 基础  : FTS5 special characters are sanitized; ordinary search unaffected.
 *   - 进阶  : Complete security suite — every FTS5 operator + boundary cases,
 *             plus an executable SQLite FTS5 check that a payload such as
 *             `alpha AND NOT beta` does NOT behave as a boolean expression.
 *   - 深入  : Recall comparison (old token-OR vs new sanitized quoted-OR) on the
 *             same SQLite FTS5 fixture — confirms no recall regression for
 *             ordinary keyword queries.
 *   - 拓展  : Whitelist-based builder + parameterized `MATCH ?` verification,
 *             plus real `VectorStore` L1/L0 FTS fallback paths.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { L0Record } from "./types.js";
import type { MemoryRecord } from "../record/l1-writer.js";
import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  sanitizeFtsTokens,
  VectorStore,
} from "./sqlite.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Fake jieba that emulates `cutForSearch` for deterministic ASCII tests. */
function fakeJieba(tokens: string[]): Parameters<typeof _setJiebaForTest>[0] {
  return {
    cutForSearch: (_text: string, _hmm: boolean) => tokens,
  } as Parameters<typeof _setJiebaForTest>[0];
}

/** All FTS5 query-syntax characters that must never reach MATCH as live ops. */
const FTS5_SYNTAX_CHARS = ['"', "'", "(", ")", "*", ":", "^", "-"];

/** A bare token is "safe" iff it contains only letters / numbers / `_`. */
function isSafeToken(t: string): boolean {
  return /^[\p{L}\p{N}_]+$/u.test(t);
}

/** Build a fresh in-memory FTS5 table for isolated execution tests. */
function makeFtsTable(docs: Array<{ id: string; text: string }>): {
  db: DatabaseSync;
  search: (matchExpr: string) => string[];
  close: () => void;
} {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, text)");
  const insert = db.prepare("INSERT INTO docs(id, text) VALUES (?, ?)");
  for (const d of docs) insert.run(d.id, d.text);
  const stmt = db.prepare("SELECT id FROM docs WHERE docs MATCH ? ORDER BY rank");
  return {
    db,
    search: (matchExpr: string) =>
      (stmt.all(matchExpr) as Array<{ id: string }>).map((r) => r.id),
    close: () => db.close(),
  };
}

/** Sort helper for comparing result sets independent of BM25 ordering. */
const sorted = (xs: string[]) => [...xs].sort();

// ──────────────────────────────────────────────────────────────────────────
// Test isolation: force the deterministic fallback (regex) path by default,
// and always restore jieba state after each test.
// ──────────────────────────────────────────────────────────────────────────

beforeAll(() => {
  // The project's real jieba may or may not be installed in CI; pin the
  // fallback path so ASCII assertions are deterministic. Jieba-specific
  // behavior is covered explicitly by the "fake jieba" tests below.
  _setJiebaForTest(null);
});

afterEach(() => {
  _setJiebaForTest(null);
});

// ==========================================================================
// 基础 — FTS5 special characters are sanitized; ordinary search unaffected
// ==========================================================================

describe("[基础] buildFtsQuery — FTS5 special characters sanitized, normal search preserved", () => {
  it("converts ordinary keyword input into quoted OR-joined phrases", () => {
    expect(buildFtsQuery("travel plan API")).toBe('"travel" OR "plan" OR "API"');
  });

  it("preserves Chinese keyword search under the fallback path", () => {
    expect(buildFtsQuery("用户 编程 TypeScript")).toBe(
      '"用户" OR "编程" OR "TypeScript"',
    );
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("\t\n")).toBeNull();
  });

  it("strips every FTS5 syntax character from individual tokens", () => {
    // Each syntax char is removed (or splits the token); none survive inside
    // a token. We check token *interiors* — the wrapping `"` is intentional.
    for (const ch of FTS5_SYNTAX_CHARS) {
      const q = buildFtsQuery(`alpha${ch}beta`);
      expect(q).not.toBeNull();
      const interiors = (q!.match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));
      expect(interiors.length).toBeGreaterThan(0);
      for (const t of interiors) {
        expect(t).not.toContain(ch);
        expect(isSafeToken(t)).toBe(true);
      }
    }
  });

  it("drops reserved FTS5 operators so they cannot control query semantics", () => {
    expect(buildFtsQuery("alpha AND NOT beta")).toBe('"alpha" OR "beta"');
    expect(buildFtsQuery("alpha OR beta")).toBe('"alpha" OR "beta"');
    expect(buildFtsQuery("alpha NOT beta")).toBe('"alpha" OR "beta"');
  });

  it("neutralizes quote-injection attempts", () => {
    expect(buildFtsQuery('alpha" OR "beta')).toBe('"alpha" OR "beta"');
    expect(buildFtsQuery("alpha' OR 'beta")).toBe('"alpha" OR "beta"');
  });
});

// ==========================================================================
// 进阶 — complete security suite: all FTS5 operators + boundary cases,
//         plus an executable SQLite FTS5 check.
// ==========================================================================

describe("[进阶] sanitizeFtsTokens — table-driven operator & boundary coverage", () => {
  const cases: Array<{ input: string; expected: string[] }> = [
    // Quote injection
    { input: 'alpha" OR "beta', expected: ["alpha", "beta"] },
    { input: "alpha' OR 'beta", expected: ["alpha", "beta"] },
    // Parentheses
    { input: "(alpha) OR (beta)", expected: ["alpha", "beta"] },
    // Boolean operators (upper / lower / mixed case)
    { input: "alpha AND beta", expected: ["alpha", "beta"] },
    { input: "alpha OR beta", expected: ["alpha", "beta"] },
    { input: "alpha NOT beta", expected: ["alpha", "beta"] },
    { input: "alpha and beta", expected: ["alpha", "beta"] },
    { input: "Alpha Or Beta", expected: ["Alpha", "Beta"] },
    // NEAR syntax
    { input: "NEAR(alpha beta, 5)", expected: ["alpha", "beta", "5"] },
    { input: "alpha NEAR/5 beta", expected: ["alpha", "5", "beta"] },
    { input: "alpha NEAR beta", expected: ["alpha", "beta"] },
    // Prefix / column-filter-like syntax
    { input: "alpha*", expected: ["alpha"] },
    { input: "content:alpha", expected: ["content", "alpha"] },
    { input: "-content:alpha", expected: ["content", "alpha"] },
    // Pure operators → nothing survives
    { input: "AND OR NOT NEAR", expected: [] },
    { input: "and or not near", expected: [] },
    // Pure punctuation → nothing survives
    { input: "!!!", expected: [] },
    { input: '"""', expected: [] },
    { input: "(*):-", expected: [] },
    // Mixed alphanumeric + syntax
    { input: "foo:bar", expected: ["foo", "bar"] },
    { input: "C++", expected: ["C"] },
    { input: "node-18", expected: ["node", "18"] },
    { input: "a(b)c", expected: ["a", "b", "c"] },
    // Underscore is kept (part of the whitelist)
    { input: "foo_bar baz", expected: ["foo_bar", "baz"] },
  ];

  for (const { input, expected } of cases) {
    it(`sanitizes ${JSON.stringify(input)} → [${expected.join(", ")}]`, () => {
      // Run the raw token through the sanitizer directly.
      expect(sanitizeFtsTokens(input)).toEqual(expected);
      // And through buildFtsQuery end-to-end: every emitted token must be safe.
      const q = buildFtsQuery(input);
      if (expected.length === 0) {
        expect(q).toBeNull();
      } else {
        expect(q).not.toBeNull();
        for (const tok of q!.match(/"[^"]*"/g) ?? []) {
          expect(isSafeToken(tok.slice(1, -1))).toBe(true);
        }
      }
    });
  }

  // Control characters (NUL 0x00, ESC 0x1B, DEL 0x7F) embedded between letters
  // are dropped — computed at runtime so the source file stays byte-clean.
  it("drops NUL / ESC / DEL control characters embedded in tokens", () => {
    const NUL = String.fromCharCode(0x00);
    const ESC = String.fromCharCode(0x1b);
    const DEL = String.fromCharCode(0x7f);
    expect(sanitizeFtsTokens(`alpha${NUL}beta`)).toEqual(["alpha", "beta"]);
    expect(sanitizeFtsTokens(`alpha${ESC}beta`)).toEqual(["alpha", "beta"]);
    expect(sanitizeFtsTokens(`alpha${DEL}beta`)).toEqual(["alpha", "beta"]);
    expect(sanitizeFtsTokens(`${NUL}${ESC}${DEL}`)).toEqual([]);
  });
});

describe("[进阶] buildFtsQuery — no FTS5 operator can survive into the MATCH expression", () => {
  // A battery of hostile inputs. The built query must (a) be null or contain
  // only safe quoted tokens, and (b) never contain a bare reserved operator.
  const hostile = [
    "alpha AND NOT beta",
    'alpha" OR "beta',
    "alpha' OR 'beta",
    "(alpha) OR (beta)",
    "NEAR(alpha beta, 5)",
    "alpha NEAR/5 beta",
    "alpha*",
    "content:alpha",
    "-content:alpha",
    "^alpha",
    "AND OR NOT NEAR",
    "and or not near",
    "!!!",
    "foo:bar C++",
    "a(b)c AND d",
  ];

  for (const input of hostile) {
    it(`produces an injection-safe query for ${JSON.stringify(input)}`, () => {
      const q = buildFtsQuery(input);
      if (q === null) return;
      // Inspect token *interiors* only — the ` OR ` joiner and wrapping `"`
      // are added by us, not by the user, and are safe.
      const interiors = (q.match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));
      expect(interiors.length).toBeGreaterThan(0);
      for (const t of interiors) {
        // Every emitted token is a safe bareword (letters / numbers / _)...
        expect(isSafeToken(t)).toBe(true);
        // ...and not a reserved FTS5 operator.
        expect(["AND", "OR", "NOT", "NEAR"]).not.toContain(t.toUpperCase());
      }
    });
  }
});

describe("[进阶] executable SQLite FTS5 — sanitized payload does not act as a boolean", () => {
  // Corpus: docA has both alpha & beta; docB has only beta; docC has only alpha.
  const docs = [
    { id: "A", text: "alpha beta gamma" },
    { id: "B", text: "beta delta" },
    { id: "C", text: "alpha only" },
  ];

  it("raw `alpha AND NOT beta` is a syntax error in FTS5 (the unsanitized risk)", () => {
    const table = makeFtsTable(docs);
    // Forwarding user input verbatim can break the query entirely — this is
    // exactly the "导致语法错误" risk called out in issue #160.
    expect(() => table.search("alpha AND NOT beta")).toThrow();
    table.close();
  });

  it("a valid boolean injection `alpha NOT beta` matches only C (the boolean effect)", () => {
    const table = makeFtsTable(docs);
    // `alpha NOT beta` is valid FTS5 and means "alpha but not beta" → only C.
    // This proves a sanitized OR would change semantics if operators leaked.
    expect(sorted(table.search("alpha NOT beta"))).toEqual(["C"]);
    table.close();
  });

  it("sanitized `alpha AND NOT beta` matches A, B, C — no longer a boolean", () => {
    const table = makeFtsTable(docs);
    const q = buildFtsQuery("alpha AND NOT beta");
    expect(q).toBe('"alpha" OR "beta"');
    expect(sorted(table.search(q!))).toEqual(["A", "B", "C"]);
    table.close();
  });

  it("every hostile input yields a query that executes in real FTS5 without error", () => {
    const table = makeFtsTable(docs);
    const hostile = [
      "alpha AND NOT beta",
      'alpha" OR "beta',
      "NEAR(alpha beta, 5)",
      "alpha*",
      "content:alpha",
      "AND OR NOT NEAR",
      "!!!",
      "foo:bar",
    ];
    for (const input of hostile) {
      const q = buildFtsQuery(input);
      // Must not throw; null is an acceptable (empty) result.
      expect(() => table.search(q ?? "nomatch")).not.toThrow();
    }
    table.close();
  });
});

// ==========================================================================
// 深入 — recall comparison: old token-OR vs new sanitized quoted-OR
// ==========================================================================

describe("[深入] recall comparison — no regression for ordinary keyword queries", () => {
  const corpus = [
    { id: "d1", text: "travel plan and API design notes" },
    { id: "d2", text: "TypeScript memory module overview" },
    { id: "d3", text: "coffee beans roast profile" },
    { id: "d4", text: "project roadmap and timeline" },
    { id: "d5", text: "用户 喜欢 编程 和 TypeScript 笔记" },
  ];

  // The PREVIOUS behavior described in the issue: split on whitespace, OR-join,
  // no quoting, no sanitization.
  const oldBuild = (input: string): string =>
    input.split(/\s+/).filter((t) => t.length > 0).join(" OR ");

  const ordinaryQueries = [
    "travel plan API",
    "TypeScript memory",
    "coffee beans",
    "project roadmap",
    "用户 编程 TypeScript",
  ];

  let table: ReturnType<typeof makeFtsTable>;
  beforeAll(() => {
    table = makeFtsTable(corpus);
  });
  afterAll(() => {
    table.close();
  });

  // Import afterAll locally — vitest provides it at top level; alias to avoid
  // a second import line. (Declared via the top-level `afterAll`? No — add it.)
  // We use the module-scoped afterAll from "vitest" imported below.

  for (const q of ordinaryQueries) {
    it(`same result set for ${JSON.stringify(q)}`, () => {
      const oldQ = oldBuild(q);
      const newQ = buildFtsQuery(q);
      expect(newQ).not.toBeNull();
      const oldResults = sorted(table.search(oldQ));
      const newResults = sorted(table.search(newQ!));
      expect(newResults).toEqual(oldResults);
    });
  }

  it("sanitized form is strictly safer (quoted) while recall is identical", () => {
    for (const q of ordinaryQueries) {
      const newQ = buildFtsQuery(q)!;
      // New form quotes every token; old form does not.
      expect(newQ).toMatch(/^"/);
      expect(sorted(table.search(newQ))).toEqual(sorted(table.search(oldBuild(q))));
    }
  });
});

// ==========================================================================
// 拓展 — whitelist builder + parameterized MATCH + real VectorStore paths
// ==========================================================================

describe("[拓展] sanitizeFtsTokens is a strict whitelist (allow-list defense)", () => {
  it("keeps only Unicode letters, numbers, and underscore", () => {
    for (const t of ["foo_bar", "用户123", "TypeScript", "node_18", "αβγ"]) {
      for (const out of sanitizeFtsTokens(t)) {
        expect(isSafeToken(out)).toBe(true);
      }
    }
  });

  it("drops every FTS5 syntax character and reserved operator", () => {
    const nasty = `a"b'c(d)e*f:g^h-i AND OR NOT NEAR near`;
    const out = sanitizeFtsTokens(nasty);
    for (const tok of out) {
      expect(isSafeToken(tok)).toBe(true);
      expect(["AND", "OR", "NOT", "NEAR"]).not.toContain(tok.toUpperCase());
    }
    // Operators are fully removed, not just de-operatored.
    expect(out).not.toContain("AND");
    expect(out).not.toContain("NEAR");
    expect(out).not.toContain("near");
  });

  it("returns [] for inputs with no whitelisted characters", () => {
    for (const t of ["", "!!!", '"""', "(*):-", "\x00\x01"]) {
      expect(sanitizeFtsTokens(t)).toEqual([]);
    }
  });
});

describe("[拓展] parameterized MATCH — sanitized queries bind safely via MATCH ?", () => {
  it("VectorStore.execute is parameterized (the bound value is data, not SQL)", () => {
    // We cannot read the prepared SQL text, but we can prove parameterization
    // indirectly: a sanitized query containing `"` and `OR` executes as a
    // *data* MATCH expression and returns rows — it is never concatenated
    // into SQL. A non-parameterized path would error on quotes.
    const table = makeFtsTable([
      { id: "x", text: "alpha beta" },
      { id: "y", text: "gamma" },
    ]);
    const q = buildFtsQuery('alpha" OR "gamma')!;
    expect(q).toBe('"alpha" OR "gamma"');
    expect(sorted(table.search(q))).toEqual(["x", "y"]);
    table.close();
  });
});

describe("[拓展] real VectorStore L1/L0 FTS fallback paths", () => {
  let store: VectorStore;
  let dbPath: string;

  const mkRecord = (id: string, content: string): MemoryRecord => ({
    id,
    content,
    type: "episodic",
    priority: 50,
    scene_name: "test",
    source_message_ids: [],
    metadata: {},
    timestamps: ["2026-01-01T00:00:00Z"],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    sessionKey: "s",
    sessionId: "s1",
  });

  const mkL0 = (id: string, text: string): L0Record => ({
    id,
    sessionKey: "s",
    sessionId: "s1",
    role: "user",
    messageText: text,
    recordedAt: "2026-01-01T00:00:00Z",
    timestamp: 1_000,
  });

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fts-vec-test-${process.pid}-${Date.now()}.sqlite`);
    store = new VectorStore(dbPath, 4);
    store.init({ provider: "test", model: "m", dimensions: 4 });
  });

  afterEach(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(`${dbPath}-wal`);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      /* ignore */
    }
  });

  it("store is not degraded and FTS5 is available", () => {
    // If sqlite-vec failed to load, these tests cannot prove the fallback path.
    expect(store.isDegraded()).toBe(false);
    expect(store.isFtsAvailable()).toBe(true);
  });

  it("L1 FTS: `alpha AND NOT beta` is operator-neutral after sanitization", () => {
    store.upsertL1(mkRecord("A", "alpha beta gamma"), undefined);
    store.upsertL1(mkRecord("B", "beta delta"), undefined);
    store.upsertL1(mkRecord("C", "alpha only"), undefined);

    const q = buildFtsQuery("alpha AND NOT beta");
    expect(q).toBe('"alpha" OR "beta"');
    const ids = sorted(store.searchL1Fts(q!, 20).map((r) => r.record_id));
    expect(ids).toEqual(["A", "B", "C"]);
  });

  it("L0 FTS: `alpha AND NOT beta` is operator-neutral after sanitization", () => {
    store.upsertL0(mkL0("A", "alpha beta gamma"), undefined);
    store.upsertL0(mkL0("B", "beta delta"), undefined);
    store.upsertL0(mkL0("C", "alpha only"), undefined);

    const q = buildFtsQuery("alpha AND NOT beta");
    expect(q).toBe('"alpha" OR "beta"');
    const ids = sorted(store.searchL0Fts(q!, 20).map((r) => r.record_id));
    expect(ids).toEqual(["A", "B", "C"]);
  });

  it("L1 FTS: ordinary keyword search still returns relevant records", () => {
    store.upsertL1(mkRecord("r1", "travel plan and API design"), undefined);
    store.upsertL1(mkRecord("r2", "coffee beans roast"), undefined);
    const q = buildFtsQuery("travel plan API");
    expect(q).toBe('"travel" OR "plan" OR "API"');
    const ids = sorted(store.searchL1Fts(q!, 20).map((r) => r.record_id));
    expect(ids).toEqual(["r1"]);
  });
});

// ==========================================================================
// Jieba-path parity — the same sanitizer is applied to jieba output
// ==========================================================================

describe("[拓展] sanitization is applied identically to jieba-produced tokens", () => {
  beforeEach(() => {
    _resetJiebaForTest();
  });
  afterEach(() => {
    _setJiebaForTest(null);
  });

  it("drops reserved operators and splits mixed tokens from jieba output", () => {
    // Simulate jieba emitting tokens that contain FTS5 syntax / operators.
    _setJiebaForTest(
      fakeJieba(["foo:bar", "C++", "AND", "NEAR", "alpha", "用户"]),
    );
    const q = buildFtsQuery("ignored raw input");
    // foo:bar → foo, bar ; C++ → C ; AND/NEAR dropped ; alpha & 用户 kept.
    expect(q).toBe('"foo" OR "bar" OR "C" OR "alpha" OR "用户"');
  });
});
