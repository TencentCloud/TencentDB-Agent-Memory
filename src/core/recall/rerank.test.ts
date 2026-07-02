import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../config";
import { applyRerankResponse, rerankRecallLines } from "./rerank";

const lines = [
  "- [episodic] old candidate",
  "- [instruction] best candidate",
  "- [persona] fallback candidate",
];

describe("applyRerankResponse", () => {
  it("reorders recall lines by remote scores and keeps unranked lines", () => {
    const reordered = applyRerankResponse(lines, {
      results: [
        { index: 1, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.12 },
      ],
    });

    expect(reordered).toEqual([
      "- [instruction] best candidate",
      "- [episodic] old candidate",
      "- [persona] fallback candidate",
    ]);
  });

  it("rejects unsupported response shapes", () => {
    expect(applyRerankResponse(lines, {})).toBeUndefined();
    expect(applyRerankResponse(lines, { results: [{ index: 9, relevance_score: 1 }] })).toBeUndefined();
  });
});

describe("rerankRecallLines", () => {
  it("is a no-op when remote rerank is disabled", async () => {
    const fetchImpl = vi.fn();
    const cfg = parseConfig({});

    await expect(rerankRecallLines({ query: "q", lines, cfg, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toBe(lines);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls a remote rerank endpoint and applies the returned order", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { index: 2, relevance_score: 0.8 },
        { index: 1, relevance_score: 0.7 },
        { index: 0, relevance_score: 0.1 },
      ],
    }), { status: 200 }));
    const cfg = parseConfig({
      recall: {
        rerank: {
          enabled: true,
          baseUrl: "https://rerank.example/v1/",
          apiKey: "secret",
          model: "bge-reranker",
        },
      },
    });

    await expect(rerankRecallLines({ query: "memory query", lines, cfg, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toEqual([
        "- [persona] fallback candidate",
        "- [instruction] best candidate",
        "- [episodic] old candidate",
      ]);

    expect(fetchImpl).toHaveBeenCalledWith("https://rerank.example/v1/rerank", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      body: JSON.stringify({
        model: "bge-reranker",
        query: "memory query",
        documents: lines,
        top_n: lines.length,
      }),
    }));
  });

  it("keeps original order when the remote call fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const cfg = parseConfig({
      recall: {
        rerank: {
          enabled: true,
          baseUrl: "https://rerank.example/v1",
          apiKey: "secret",
          model: "bge-reranker",
        },
      },
    });

    await expect(rerankRecallLines({ query: "q", lines, cfg, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .resolves.toBe(lines);
  });
});
