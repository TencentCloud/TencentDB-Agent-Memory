import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingService } from "./embedding.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIEmbeddingService batching", () => {
  it("splits remote embedding requests into batches of at most 10 texts", async () => {
    const batchSizes: number[] = [];

    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      const input = body.input ?? [];
      batchSizes.push(input.length);

      if (input.length > 10) {
        return new Response(JSON.stringify({ error: { message: "batch size is invalid" } }), {
          status: 400,
          statusText: "Bad Request",
        });
      }

      return Response.json({
        data: input.map((_text, index) => ({
          index,
          embedding: [index + 1, 0, 0],
        })),
      });
    }));

    const service = new OpenAIEmbeddingService({
      provider: "dashscope",
      baseUrl: "https://dashscope.example/v1",
      apiKey: "test-key",
      model: "text-embedding-v4",
      dimensions: 3,
      sendDimensions: false,
    });

    const embeddings = await service.embedBatch(Array.from({ length: 11 }, (_value, index) => `text-${index}`));

    expect(embeddings).toHaveLength(11);
    expect(batchSizes).toEqual([10, 1]);
  });
});
