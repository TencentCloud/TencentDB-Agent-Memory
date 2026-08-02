/**
 * P10 — recall quality probe (#1): corpus loading + precision computation.
 * Pure functions with an injected search — no gateway, no real embeddings.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProbeCorpus, computeProbeResults, isRelevant, type ProbeCorpus } from "./probe.js";

function tempCorpus(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-probe-"));
  const file = path.join(dir, "probe-corpus.json");
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

describe("loadProbeCorpus", () => {
  it("returns null for a missing file (fail-open)", () => {
    expect(loadProbeCorpus("/nonexistent/probe-corpus.json")).toBeNull();
  });

  it("parses a valid corpus", () => {
    const file = tempCorpus(
      JSON.stringify({
        queries: [
          { id: "q1", query: "what is the user's name?", expected: ["User name is Alice"] },
          { id: "q2", query: "preferred editor?", expected: ["prefers vim", "uses neovim"] },
        ],
      }),
    );
    try {
      const corpus = loadProbeCorpus(file);
      expect(corpus).not.toBeNull();
      expect(corpus!.queries).toHaveLength(2);
      expect(corpus!.queries[1]!.expected).toEqual(["prefers vim", "uses neovim"]);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("returns null for malformed JSON", () => {
    const file = tempCorpus("{ not json ");
    try {
      expect(loadProbeCorpus(file)).toBeNull();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("returns null for a wrong shape (no queries array)", () => {
    const file = tempCorpus(JSON.stringify({ foo: 1 }));
    try {
      expect(loadProbeCorpus(file)).toBeNull();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("skips entries without non-empty expected answers", () => {
    const file = tempCorpus(
      JSON.stringify({
        queries: [
          { id: "q1", query: "x", expected: [] },
          { id: "q2", query: "y", expected: ["good"] },
        ],
      }),
    );
    try {
      const corpus = loadProbeCorpus(file);
      expect(corpus!.queries).toHaveLength(1);
      expect(corpus!.queries[0]!.id).toBe("q2");
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe("isRelevant", () => {
  it("matches on trimmed content containing an expected substring", () => {
    expect(isRelevant("  User name is Alice.  ", ["User name is Alice"])).toBe(true);
  });
  it("does not match when no expected substring is present", () => {
    expect(isRelevant("User name is Bob", ["User name is Alice"])).toBe(false);
  });
  it("handles empty content", () => {
    expect(isRelevant("   ", ["x"])).toBe(false);
  });
});

describe("computeProbeResults (precision@k)", () => {
  const corpus: ProbeCorpus = {
    queries: [
      { id: "q1", query: "q1", expected: ["alpha"] },
      { id: "q2", query: "q2", expected: ["beta"] },
      { id: "q3", query: "q3", expected: ["gamma", "delta"] },
    ],
  };

  it("precision@k = 1 when every query's answer is in top-1", async () => {
    const search = async (q: string) =>
      q === "q3"
        ? [{ content: "gamma here" }, { content: "delta here" }]
        : [{ content: q === "q1" ? "alpha found" : "beta found" }];
    const r = await computeProbeResults(corpus, 3, search);
    expect(r.status).toBe("ok");
    expect(r.precisionAtK).toBe(1);
    expect(r.top1HitRate).toBe(1);
  });

  it("partial precision — answers ranked below top-1 count partially", async () => {
    // q1: expected alpha at rank 3 of 3 → precision = 1/min(3,1)=1 hit fraction...
    // Use a stricter topK=1: only the rank-1 result counts.
    const search = async (q: string) => [
      { content: "unrelated result" },
      { content: "alpha found" }, // rank 2
    ];
    const r = await computeProbeResults({ queries: [{ id: "q1", query: "q1", expected: ["alpha"] }] }, 1, search);
    expect(r.precisionAtK).toBe(0);
    expect(r.top1HitRate).toBe(0);
  });

  it("denominator is min(topK, #expected)", async () => {
    // expected has 2 answers, both retrieved in top-3 → precision 1.0
    const search = async () => [{ content: "gamma here" }, { content: "delta here" }];
    const r = await computeProbeResults({ queries: [{ id: "q3", query: "q3", expected: ["gamma", "delta"] }] }, 3, search);
    expect(r.precisionAtK).toBe(1);
  });

  it("a search error counts as 0 hits for that query (fail-open)", async () => {
    const search = async () => {
      throw new Error("boom");
    };
    const r = await computeProbeResults(corpus, 3, search);
    expect(r.precisionAtK).toBe(0);
    expect(r.status).toBe("ok"); // probe itself still reports a result
  });

  it("records per-query evaluated results in rank order", async () => {
    const search = async () => [{ content: "a" }, { content: "b" }];
    const r = await computeProbeResults({ queries: [{ id: "q9", query: "x", expected: ["a"] }] }, 3, search);
    expect(r.evaluated[0]!.top).toEqual(["a", "b"]);
    expect(r.evaluated[0]!.hits).toBe(1);
  });
});
