import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIEmbeddingService } from "./embedding.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function createService(batchSize?: number): OpenAIEmbeddingService {
  return new OpenAIEmbeddingService({
    provider: "dashscope",
    baseUrl: "https://dashscope.example/v1",
    apiKey: "test-key",
    model: "text-embedding-v4",
    dimensions: 2,
    sendDimensions: false,
    batchSize,
  });
}

function stubEmbeddingApi(batchSizes: number[]): void {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    batchSizes.push(body.input.length);
    if (body.input.length > 10) {
      return new Response("batch size is invalid", { status: 400, statusText: "Bad Request" });
    }
    return Response.json({
      data: body.input.map((_text, index) => ({ index, embedding: [index + 1, 1] })),
    });
  }));
}

describe("OpenAIEmbeddingService remote batching", () => {
  it("keeps every default request within the DashScope limit", async () => {
    const batchSizes: number[] = [];
    stubEmbeddingApi(batchSizes);

    const embeddings = await createService().embedBatch(
      Array.from({ length: 21 }, (_value, index) => `text-${index}`),
    );

    expect(batchSizes).toEqual([10, 10, 1]);
    expect(embeddings).toHaveLength(21);
  });

  it("allows an explicit larger limit for providers that support it", async () => {
    const batchSizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      batchSizes.push(body.input.length);
      return Response.json({
        data: body.input.map((_text, index) => ({ index, embedding: [index + 1, 1] })),
      });
    }));

    await createService(256).embedBatch(Array.from({ length: 11 }, (_, index) => `text-${index}`));

    expect(batchSizes).toEqual([11]);
  });

  it.each([0, 1.5, 2049])("rejects invalid batchSize %s", (batchSize) => {
    expect(() => createService(batchSize)).toThrow(/batchSize must be an integer between 1 and 2048/);
  });
});
