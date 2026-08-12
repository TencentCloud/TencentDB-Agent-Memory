/**
 * P10 — recall quality probe (#1): corpus loading + precision computation.
 * Pure functions with an injected search — no gateway, no real embeddings.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadProbeCorpus,
  computeProbeResults,
  isRelevant,
  type ProbeCorpus,
} from "./probe.js";
import type { RecallItem } from "../core/hooks/auto-recall.js";

/**
 * A retrieved item as the recall pipeline would hand it over. Only the fields
 * the probe reads are filled in; the rest of `RecallItem` is irrelevant here.
 */
function hit(
  content: string,
  extra: { id?: string; projectId?: string; scope?: string; raw?: number; final?: number } = {},
): RecallItem {
  const raw = extra.raw ?? 1;
  return {
    schemaVersion: 1,
    memoryId: extra.id ?? content,
    kind: "l1",
    content,
    formatable: { type: "episodic", content },
    scope: { userId: null, projectId: extra.projectId, scope: extra.scope },
    provenance: { sourceIds: [], producer: "test", createdAt: "", updatedAt: "", status: "unknown" },
    score: { raw, final: extra.final ?? raw, reasons: [] },
  };
}

/** Wrap plain contents into the search-result shape the probe expects. */
const found = (...contents: string[]) => ({ items: contents.map((c) => hit(c)) });

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
          {
            id: "q1",
            query: "what is the user's name?",
            expected: ["User name is Alice"],
          },
          {
            id: "q2",
            query: "preferred editor?",
            expected: ["prefers vim", "uses neovim"],
          },
        ],
      }),
    );
    try {
      const corpus = loadProbeCorpus(file);
      expect(corpus).not.toBeNull();
      expect(corpus!.queries).toHaveLength(2);
      expect(corpus!.queries[1]!.expected).toEqual([
        "prefers vim",
        "uses neovim",
      ]);
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
    expect(isRelevant("  User name is Alice.  ", ["User name is Alice"])).toBe(
      true,
    );
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
        ? found("gamma here", "delta here")
        : found(q === "q1" ? "alpha found" : "beta found");
    const r = await computeProbeResults(corpus, 3, search);
    expect(r.status).toBe("ok");
    expect(r.precisionAtK).toBe(1);
    expect(r.top1HitRate).toBe(1);
  });

  it("partial precision — answers ranked below top-1 count partially", async () => {
    // q1: expected alpha at rank 3 of 3 → precision = 1/min(3,1)=1 hit fraction...
    // Use a stricter topK=1: only the rank-1 result counts.
    const search = async () => found("unrelated result", "alpha found");
    const r = await computeProbeResults(
      { queries: [{ id: "q1", query: "q1", expected: ["alpha"] }] },
      1,
      search,
    );
    expect(r.precisionAtK).toBe(0);
    expect(r.top1HitRate).toBe(0);
  });

  it("top1HitRate = 0 when the answer is at rank 2 even with topK>1 (precision@k stays 1)", async () => {
    // Bug regression: any relevant hit in top-k used to count as a top-1 hit.
    const search = async () => found("irrelevant rank-1", "alpha found");
    const r = await computeProbeResults(
      { queries: [{ id: "q1", query: "q1", expected: ["alpha"] }] },
      3,
      search,
    );
    expect(r.top1HitRate).toBe(0);
    expect(r.precisionAtK).toBe(1);
  });

  it("top1HitRate = 1 when the answer is at rank 1 (with irrelevant results below)", async () => {
    const search = async () => found("alpha found", "irrelevant rank-2");
    const r = await computeProbeResults(
      { queries: [{ id: "q1", query: "q1", expected: ["alpha"] }] },
      3,
      search,
    );
    expect(r.top1HitRate).toBe(1);
    expect(r.precisionAtK).toBe(1);
  });

  it("denominator is min(topK, #expected)", async () => {
    // expected has 2 answers, both retrieved in top-3 → precision 1.0
    const search = async () => found("gamma here", "delta here");
    const r = await computeProbeResults(
      { queries: [{ id: "q3", query: "q3", expected: ["gamma", "delta"] }] },
      3,
      search,
    );
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
    const search = async () => found("a", "b");
    const r = await computeProbeResults(
      { queries: [{ id: "q9", query: "x", expected: ["a"] }] },
      3,
      search,
    );
    expect(r.evaluated[0]!.top).toEqual(["a", "b"]);
    expect(r.evaluated[0]!.hits).toBe(1);
  });
});

describe("computeProbeResults: foreign-project leakage (tz-10a)", () => {
  const corpus: ProbeCorpus = {
    queries: [
      {
        id: "q-scoped",
        query: "deploy steps",
        expected: ["deploy with rsync"],
        projectId: "/home/u/this",
        foreignExpected: ["deploy with kubectl"],
      },
    ],
  };

  it("counts a foreign negative in the top-k as leakage and names the item", async () => {
    const search = async (_q: string, projectId: string) => ({
      items: [
        hit("deploy with rsync", { id: "own", projectId, scope: "project", raw: 0.9 }),
        hit("deploy with kubectl", { id: "alien", projectId: "/home/u/other", scope: "project", raw: 0.8, final: 0.4 }),
      ],
    });
    const r = await computeProbeResults(corpus, 3, search);

    expect(r.leakageRate).toBe(1);
    const leaked = r.evaluated[0]!.items.find((i) => i.foreign);
    expect(leaked?.memoryId).toBe("alien");
    expect(leaked?.projectId).toBe("/home/u/other");
    // The decay is visible, not merely assumed: raw and final differ.
    expect(leaked!.final).toBeLessThan(leaked!.raw);
    expect(r.evaluated[0]!.foreignHits).toBe(1);
    expect(r.precisionAtK).toBe(1);
  });

  it("leakageRate is 0 when the foreign negative stays out of the top-k", async () => {
    const search = async (_q: string, projectId: string) => ({
      items: [hit("deploy with rsync", { projectId, scope: "project" })],
    });
    expect((await computeProbeResults(corpus, 3, search)).leakageRate).toBe(0);
  });

  it("a query without project context is a separate baseline, not leakage data", async () => {
    const search = async () => found("deploy with kubectl");
    const r = await computeProbeResults(
      { queries: [{ id: "q-plain", query: "deploy steps", expected: ["deploy with rsync"] }] },
      3,
      search,
    );
    expect(r.leakageRate).toBeNull();
    expect(r.evaluated[0]!.projectId).toBe("");
  });

  it("passes the query's projectId to the search", async () => {
    const seen: string[] = [];
    const search = async (_q: string, projectId: string) => {
      seen.push(projectId);
      return found("deploy with rsync");
    };
    await computeProbeResults(corpus, 3, search);
    expect(seen).toEqual(["/home/u/this"]);
  });

  it("a failing query is reported as a diagnostic, not as an empty memory", async () => {
    const search = async () => {
      throw new Error("store exploded");
    };
    const r = await computeProbeResults(corpus, 3, search);
    expect(r.diagnostics.map((d) => d.code)).toContain("probe-query-failed");
    expect(r.diagnostics[0]!.message).toContain("store exploded");
  });
});

describe("loadProbeCorpus: project fields (tz-10a)", () => {
  it("keeps projectId and foreignExpected, and stays back-compatible", () => {
    const file = tempCorpus(
      JSON.stringify({
        queries: [
          { id: "q1", query: "a", expected: ["x"], projectId: "/p", foreignExpected: ["y", " "] },
          { id: "q2", query: "b", expected: ["z"] },
        ],
      }),
    );
    try {
      const corpus = loadProbeCorpus(file)!;
      expect(corpus.queries[0]!.projectId).toBe("/p");
      expect(corpus.queries[0]!.foreignExpected).toEqual(["y"]);
      expect(corpus.queries[1]!.projectId).toBeUndefined();
      expect(corpus.queries[1]!.foreignExpected).toEqual([]);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});
