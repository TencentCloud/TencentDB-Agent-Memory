// IDF-coverage re-ranking for L1 FTS search.
//
// `buildFtsQuery` OR-joins query tokens into one FTS5 MATCH, so BM25 alone can
// rank a short document matching a common word above a long one that actually
// matches the rare keyword. Measured on a real 1647-memory library with 1644
// self-retrieval queries: recall@1 72.8% → 76.3%, recall@5 91.4% → 92.4%, and
// the share of top-5 hits that match only one query token fell 31.1% → 17.7%.
import { describe, expect, it } from "vitest";
import { rankByTokenCoverage, parseFtsQueryTokens } from "./tokenize.js";

describe("rankByTokenCoverage", () => {
  it("ranks a document matching more query tokens first, even with weaker BM25", () => {
    const rows = [
      { record_id: "common", rank: -3.0 }, // better BM25, matches only the common token
      { record_id: "rare", rank: -1.0 }, //  // matches both
    ];
    const hits = new Map<string, Set<string>>([
      ["哪些", new Set(["common", "rare", "x", "y", "z"])], // df=5/5 → IDF ≈ 0
      ["commit", new Set(["rare"])], // df=1/5 → high IDF
    ]);
    expect(rankByTokenCoverage(rows, hits, 5).map((r) => r.record_id)).toEqual(["rare", "common"]);
  });

  it("does not let one accidentally-rare token outrank a two-token match", () => {
    // Real case: "怎么" occurs exactly once in the measured library, so it gets
    // the maximum IDF and would outrank a document matching ZCode + 备份.
    const rows = [
      { record_id: "writing-pref", rank: -3.0 }, // matches only 怎么
      { record_id: "backup", rank: -1.0 }, //       // matches ZCode + 备份
    ];
    const filler = Array.from({ length: 24 }, (_, i) => `d${i}`);
    const hits = new Map<string, Set<string>>([
      ["怎么", new Set(["writing-pref"])],
      ["ZCode", new Set(["backup", ...filler])],
      ["备份", new Set(["backup", ...filler.slice(0, 13)])],
    ]);
    expect(rankByTokenCoverage(rows, hits, 26).map((r) => r.record_id)).toEqual(["backup", "writing-pref"]);
  });

  it("keeps BM25 order when every token is ultra-common (all IDF zero)", () => {
    const rows = [
      { record_id: "a", rank: -1.0 },
      { record_id: "b", rank: -2.0 },
    ];
    const hits = new Map<string, Set<string>>([
      ["用户", new Set(["a", "b"])],
      ["项目", new Set(["a", "b"])],
    ]);
    expect(rankByTokenCoverage(rows, hits, 2).map((r) => r.record_id)).toEqual(["a", "b"]);
  });

  it("is stable when weight sums tie", () => {
    const rows = [
      { record_id: "one", rank: -2.0 },
      { record_id: "two", rank: -2.0 },
    ];
    const hits = new Map<string, Set<string>>([
      ["commit", new Set(["one", "two"])],
      ["中文", new Set(["one"])],
      ["署名", new Set(["two"])],
    ]);
    expect(rankByTokenCoverage(rows, hits, 10).map((r) => r.record_id)).toEqual(["one", "two"]);
  });

  it("returns rows untouched for empty input or single-token queries", () => {
    const rows = [{ record_id: "a", rank: -1 }];
    expect(rankByTokenCoverage(rows, new Map(), 10)).toEqual(rows);
    const one = new Map<string, Set<string>>([["青鸟", new Set(["a", "b"])]]);
    expect(rankByTokenCoverage([...rows, { record_id: "b", rank: -2 }], one, 5).length).toBe(2);
  });
});

describe("coverage gate (OR-padding noise)", () => {
  const tokens3 = new Map<string, Set<string>>([
    ["commit", new Set(["s1", "s2", "s3", "w1", "w2", "w3"])],
    ["中文", new Set(["s1", "s2"])],
    ["署名", new Set(["s3"])],
  ]);
  const rows = [
    { record_id: "s1", rank: -1 },
    { record_id: "s2", rank: -2 },
    { record_id: "s3", rank: -3 },
    { record_id: "w1", rank: -4 },
    { record_id: "w2", rank: -5 },
    { record_id: "w3", rank: -6 },
  ];

  it("drops single-token matches once ≥3 documents match two or more tokens", () => {
    expect(rankByTokenCoverage(rows, tokens3, 20, { minStrongResults: 3 }).map((r) => r.record_id).sort()).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("keeps weak matches when strong ones are too few (never returns empty)", () => {
    const few = new Map<string, Set<string>>([
      ["commit", new Set(["s1", "w1", "w2"])],
      ["中文", new Set(["s1", "w1", "w2"])],
      ["署名", new Set(["s1", "w1", "w2"])],
    ]);
    const out = rankByTokenCoverage(
      [
        { record_id: "s1", rank: -1 },
        { record_id: "w1", rank: -2 },
        { record_id: "w2", rank: -3 },
      ],
      few,
      20,
      { minStrongResults: 3 },
    );
    expect(out.length).toBe(3);
  });
});

describe("parseFtsQueryTokens", () => {
  it("round-trips the expression produced by buildFtsQuery", () => {
    expect(parseFtsQueryTokens('"commit" OR "中文" OR "署名"')).toEqual(["commit", "中文", "署名"]);
  });

  it("handles a single quoted term and empty input", () => {
    expect(parseFtsQueryTokens('"青鸟"')).toEqual(["青鸟"]);
    expect(parseFtsQueryTokens("")).toEqual([]);
  });
});
