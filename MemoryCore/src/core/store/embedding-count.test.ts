/**
 * Regression tests for the embedding-response count contract (issue #1020).
 *
 * `OpenAIEmbeddingService._callApi()` mapped whatever the API returned
 * straight through, so a short response produced a short array. Every caller
 * treats embedding failure as non-fatal (metadata-only writes, FTS fallback),
 * so the misalignment was invisible: `results[i]` was `undefined` for the tail
 * and the affected records were stored without — or with a foreign — vector.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIEmbeddingService } from "./embedding.js";

const config = {
  provider: "openai",
  baseUrl: "https://embeddings.test/v1",
  apiKey: "test-key",
  model: "test-embed",
  dimensions: 4,
};

/** Build an OpenAI-compatible `/embeddings` response with `count` vectors. */
function stubResponse(count: number): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      data: Array.from({ length: count }, (_, i) => ({
        index: i,
        embedding: [i, i, i, i],
      })),
    }),
  })) as never);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIEmbeddingService embedding count", () => {
  it("returns an embedding per requested text", async () => {
    stubResponse(3);
    const service = new OpenAIEmbeddingService(config);

    const result = await service.embedBatch(["a", "b", "c"]);

    expect(result).toHaveLength(3);
    expect(result.every((v) => v instanceof Float32Array && v.length === 4)).toBe(true);
  });

  it("rejects a short response instead of returning a shorter array", async () => {
    stubResponse(2);
    const service = new OpenAIEmbeddingService(config);

    // 5 inputs, 2 embeddings back. Before the fix this resolved with a
    // 2-element array and `results[2..4]` were undefined.
    await expect(service.embedBatch(["a", "b", "c", "d", "e"])).rejects.toThrow(
      /returned 2 embeddings for 5 inputs/,
    );
  });

  it("rejects an empty response from single-text embed()", async () => {
    stubResponse(0);
    const service = new OpenAIEmbeddingService(config);

    await expect(service.embed("a")).rejects.toThrow(
      /returned 0 embeddings for 1 inputs/,
    );
  });

  it("rejects an over-long response", async () => {
    stubResponse(3);
    const service = new OpenAIEmbeddingService(config);

    await expect(service.embedBatch(["a", "b"])).rejects.toThrow(
      /returned 3 embeddings for 2 inputs/,
    );
  });
});
