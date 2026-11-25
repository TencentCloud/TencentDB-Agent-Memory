/**
 * Tests for #236 — embedBatch must chunk into provider-appropriate batch
 * sizes (config.embedding.maxBatchSize) instead of sending up to 256 texts
 * to APIs that reject large batches (e.g. Dashscope limit = 10).
 */

import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingService } from "./embedding.js";

function makeService(maxBatchSize?: number) {
  const svc = new OpenAIEmbeddingService({
    provider: "openai",
    baseUrl: "https://api.test/v1",
    apiKey: "k",
    model: "m",
    dimensions: 3,
    maxBatchSize,
  } as never);

  const calls: string[][] = [];
  (svc as unknown as { _callApi: (t: string[]) => Promise<Float32Array[]> })._callApi = vi.fn(
    async (texts: string[]) => texts.map(() => new Float32Array(3)),
  ) as never;
  const callApi = (svc as unknown as { _callApi: (t: string[]) => Promise<Float32Array[]> })._callApi as ReturnType<typeof vi.fn>;
  callApi.mockImplementation(async (texts: string[]) => {
    calls.push(texts);
    return texts.map(() => new Float32Array(3));
  });

  return { svc, calls };
}

describe("embedBatch maxBatchSize (#236)", () => {
  it("chunks texts above maxBatchSize into separate API calls", async () => {
    const { svc, calls } = makeService(10);
    const texts = Array.from({ length: 25 }, (_, i) => `text ${i}`);

    await svc.embedBatch(texts);

    // 25 texts / 10 per batch → 3 calls (10 / 10 / 5)
    expect(calls.length).toBe(3);
    expect(calls[0]).toHaveLength(10);
    expect(calls[1]).toHaveLength(10);
    expect(calls[2]).toHaveLength(5);
  });

  it("sends one call when under maxBatchSize", async () => {
    const { svc, calls } = makeService(10);
    await svc.embedBatch(["a", "b", "c"]);
    expect(calls.length).toBe(1);
    expect(calls[0]).toHaveLength(3);
  });

  it("defaults to MAX_BATCH_SIZE (256) when not configured", async () => {
    const { svc, calls } = makeService(undefined);
    await svc.embedBatch(Array.from({ length: 300 }, (_, i) => `t${i}`));
    // 300 / 256 → 2 calls (256 + 44)
    expect(calls.length).toBe(2);
    expect(calls[0]).toHaveLength(256);
    expect(calls[1]).toHaveLength(44);
  });
});
