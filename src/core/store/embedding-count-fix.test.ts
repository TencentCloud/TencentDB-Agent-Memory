/**
 * Bug #5 fix verification: embedBatch now validates returned count
 * and throws when API returns fewer embeddings than requested.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { OpenAIEmbeddingService } from "./embedding.js";

function createServiceWithMockedFetch(
  responseBuilder: (texts: string[]) => { data: Array<{ index: number; embedding: number[] }> },
) {
  const service = new OpenAIEmbeddingService(
    {
      provider: "openai",
      baseUrl: "https://mock-api.example.com",
      apiKey: "test-key",
      model: "test-model",
      dimensions: 4,
      maxInputChars: 10000,
      timeoutMs: 5000,
    },
    undefined,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: string, _init: RequestInit) => {
    const body = JSON.parse(_init.body as string) as { input: string[] };
    const responseData = responseBuilder(body.input);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => responseData,
      text: async () => JSON.stringify(responseData),
    } as Response;
  }) as unknown as typeof fetch;

  return {
    service,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("Bug #5 fix: embedBatch validates returned count", () => {
  let mock: ReturnType<typeof createServiceWithMockedFetch>;

  afterEach(() => {
    mock?.restore();
  });

  it("throws when API returns fewer embeddings than requested", async () => {
    mock = createServiceWithMockedFetch((texts) => {
      const subset = texts.slice(0, 2);
      return {
        data: subset.map((_, i) => ({
          index: i,
          embedding: [0.1, 0.2, 0.3, 0.4],
        })),
      };
    });

    const texts = ["text1", "text2", "text3", "text4", "text5"];
    await expect(mock.service.embedBatch(texts)).rejects.toThrow(
      /count mismatch/,
    );
  });

  it("throws when API returns only 1 embedding for 3 texts", async () => {
    mock = createServiceWithMockedFetch(() => ({
      data: [
        {
          index: 0,
          embedding: [1.0, 0.0, 0.0, 0.0],
        },
      ],
    }));

    const texts = ["a", "b", "c"];
    await expect(mock.service.embedBatch(texts)).rejects.toThrow(
      /count mismatch/,
    );
  });

  it("works fine when API returns correct count", async () => {
    mock = createServiceWithMockedFetch((texts) => ({
      data: texts.map((_, i) => ({
        index: i,
        embedding: [0.1, 0.2, 0.3, 0.4],
      })),
    }));

    const texts = ["text1", "text2", "text3"];
    const results = await mock.service.embedBatch(texts);
    expect(results.length).toBe(3);
    expect(results[0]).toBeInstanceOf(Float32Array);
  });

  it("embed for single text works fine (normal case)", async () => {
    mock = createServiceWithMockedFetch((texts) => ({
      data: texts.map((_, i) => ({
        index: i,
        embedding: [0.1, 0.2, 0.3, 0.4],
      })),
    }));

    const result = await mock.service.embed("test text");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(4);
  });
});
