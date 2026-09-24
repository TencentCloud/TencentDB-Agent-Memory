import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingService } from "./embedding.js";

describe("OpenAIEmbeddingService", () => {
  it("retries a transient embedding API failure before succeeding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [3, 4] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const service = new OpenAIEmbeddingService({
      apiKey: "test-key",
      baseUrl: "https://embedding.example.test",
      model: "test-model",
      dimensions: 2,
      timeoutMs: 1_000,
    });

    await expect(service.embed("retry me")).resolves.toEqual(new Float32Array([0.6, 0.8]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
