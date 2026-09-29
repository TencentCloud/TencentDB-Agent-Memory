/**
 * Tests for store-layer tokenization, focused on the #1382 regression.
 *
 * Root cause being pinned: when `@node-rs/jieba` cannot be loaded (native
 * module missing in bundled deployments), the old fallback stored RAW text on
 * the write side and matched whole latin-ish runs on the query side. FTS5's
 * unicode61 tokenizer then kept each contiguous CJK run as one giant token,
 * so short CJK queries ("口令") matched nothing while ASCII markers still
 * worked — silent recall degradation.
 *
 * The fix introduces segmentCjkFallback (CJK unigram+bigram) used on BOTH the
 * write and query sides. Tests run the degraded path with jieba force-disabled
 * (_setJiebaForTest(null)) so they are deterministic even where the native
 * module exists, and the jieba path with a deterministic fake dictionary.
 *
 * The FTS5 end-to-end cases use Node's built-in `node:sqlite`, mirroring how
 * sqlite/memory-store.ts constructs its virtual tables (default unicode61
 * tokenizer).
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetJiebaForTest,
  _setJiebaForTest,
  buildFtsQuery,
  extractQueryTokens,
  segmentCjkFallback,
  tokenizeForFts,
} from "./tokenize.js";

const require = createRequire(import.meta.url);

describe("segmentCjkFallback — pure segmentation", () => {
  it("index mode splits a CJK run into unigrams + bigrams (interleaved per position)", () => {
    expect(segmentCjkFallback("闪电阻尼器")).toEqual([
      "闪", "闪电", "电", "电阻", "阻", "阻尼", "尼", "尼器", "器",
    ]);
  });

  it("queryMode omits unigrams of multi-character runs (query precision)", () => {
    expect(segmentCjkFallback("闪电阻尼器", { queryMode: true })).toEqual([
      "闪电", "电阻", "阻尼", "尼器",
    ]);
    // a two-character run keeps its bigram only
    expect(segmentCjkFallback("口令", { queryMode: true })).toEqual(["口令"]);
    // single-character runs still yield their unigram so 1-char queries work
    expect(segmentCjkFallback("好", { queryMode: true })).toEqual(["好"]);
  });

  it("keeps latin/digit runs whole", () => {
    expect(segmentCjkFallback("API")).toEqual(["API"]);
    expect(segmentCjkFallback("MARKER-ZQ-7198dfe0")).toEqual([
      "MARKER", "ZQ", "7198dfe0",
    ]);
  });

  it("separates CJK and latin scripts inside a mixed word run", () => {
    expect(segmentCjkFallback("部署API服务")).toEqual([
      "部", "部署", "署", "API", "服", "服务", "务",
    ]);
    expect(segmentCjkFallback("部署API服务", { queryMode: true })).toEqual([
      "部署", "API", "服务",
    ]);
  });

  it("does not create bigrams across punctuation", () => {
    const tokens = segmentCjkFallback("口令。测试", { queryMode: true });
    expect(tokens).not.toContain("令。");
    expect(tokens).not.toContain("。测");
    expect(tokens).toContain("口令");
    expect(tokens).toContain("测试");
  });

  it("handles empty and punctuation-only input", () => {
    expect(segmentCjkFallback("")).toEqual([]);
    expect(segmentCjkFallback("。。。！")).toEqual([]);
  });
});

describe("degraded mode (jieba unavailable) — the #1382 regression", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("buildFtsQuery returns a usable MATCH query for a short CJK query", () => {
    _setJiebaForTest(null);
    // Before the fix: fell through to whole-run tokens and still produced a
    // query, but the WRITE side stored raw sentences so nothing could match.
    // The query itself must at minimum contain the two-char word as a term.
    expect(buildFtsQuery("口令")).toBe('"口令"');
  });

  it("buildFtsQuery emits word + sub-word terms for longer CJK queries", () => {
    _setJiebaForTest(null);
    const q = buildFtsQuery("专属测试口令");
    expect(q).not.toBeNull();
    for (const term of ["口令", "测试", "专属"]) {
      expect(q).toContain(`"${term}"`);
    }
  });

  it("buildFtsQuery keeps latin runs whole (previous fallback behavior)", () => {
    _setJiebaForTest(null);
    expect(buildFtsQuery("MARKER-ZQ-7198dfe0")).toBe(
      '"MARKER" OR "ZQ" OR "7198dfe0"',
    );
  });

  it("still returns null for punctuation-only or stop-word-only queries", () => {
    _setJiebaForTest(null);
    expect(buildFtsQuery("。。。！")).toBeNull();
    expect(buildFtsQuery("的")).toBeNull();
  });

  it("tokenizeForFts stores segmented tokens, not the raw sentence", () => {
    _setJiebaForTest(null);
    const stored = tokenizeForFts("我的专属测试口令是");
    expect(stored).not.toBe("我的专属测试口令是");
    const parts = stored.split(" ");
    expect(parts).toContain("口令");
    expect(parts).toContain("测试");
    expect(parts).toContain("专属");
  });

  it("extractQueryTokens matches the FTS query terms", () => {
    _setJiebaForTest(null);
    expect(extractQueryTokens("口令")).toEqual(["口令"]);
  });

  it("write-side and query-side tokens stay aligned", () => {
    _setJiebaForTest(null);
    const docTokens = new Set(tokenizeForFts("我的专属测试口令是").split(" "));
    for (const q of ["口令", "测试", "专属"]) {
      for (const term of extractQueryTokens(q)) {
        expect(docTokens.has(term)).toBe(true);
      }
    }
  });
});

describe("jieba path (deterministic fake dictionary)", () => {
  afterEach(() => {
    _resetJiebaForTest();
  });

  it("uses the injected dictionary and stays aligned with the write side", () => {
    _setJiebaForTest({
      cutForSearch: (text: string) => {
        if (text.includes("专属")) return ["我", "专属", "测试", "口令", "是"];
        if (text === "口令") return ["口令"];
        return [text];
      },
    });
    const stored = tokenizeForFts("我的专属测试口令是");
    expect(stored).toBe("我 专属 测试 口令 是");
    expect(buildFtsQuery("口令")).toBe('"口令"');
  });
});

describe("FTS5 end-to-end (node:sqlite, unicode61 default tokenizer)", () => {
  const { DatabaseSync } = require("node:sqlite");

  function queryDoc(doc: string, query: string): number {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
    db.prepare("INSERT INTO t (content) VALUES (?)").run(tokenizeForFts(doc));
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return 0;
    return (
      db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH ?").get(ftsQuery) as {
        n: number;
      }
    ).n;
  }

  it("short CJK query hits a document containing it — jieba present", () => {
    expect(queryDoc("我的专属测试口令是 MARKER-ZQ-7198dfe0", "口令")).toBe(1);
  });

  it("short CJK query hits with jieba force-disabled — the #1382 case, previously 0 hits", () => {
    _setJiebaForTest(null);
    try {
      // Before the fix this returned 0: the doc was stored as one raw CJK run.
      expect(queryDoc("我的专属测试口令是", "口令")).toBe(1);
      expect(queryDoc("我的专属测试口令是", "测试")).toBe(1);
      // cross-word boundary query still matches via bigrams
      expect(queryDoc("我的专属测试口令是", "测试口令")).toBe(1);
    } finally {
      _resetJiebaForTest();
    }
  });

  it("ASCII marker queries keep working in degraded mode (the green smoke test)", () => {
    _setJiebaForTest(null);
    try {
      expect(queryDoc("标记 MARKER-ZQ-7198dfe0 已存档", "MARKER-ZQ-7198dfe0")).toBe(1);
    } finally {
      _resetJiebaForTest();
    }
  });
});
