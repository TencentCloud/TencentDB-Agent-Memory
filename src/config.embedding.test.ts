import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

const validRemoteEmbedding = {
  enabled: true,
  provider: "dashscope",
  baseUrl: "https://dashscope.example/v1",
  apiKey: "test-key",
  model: "text-embedding-v4",
  dimensions: 1024,
};

describe("embedding.batchSize config", () => {
  it("defaults remote providers to the DashScope-safe limit", () => {
    const config = parseConfig({ embedding: validRemoteEmbedding });

    expect(config.embedding.enabled).toBe(true);
    expect(config.embedding.batchSize).toBe(10);
    expect(config.embedding.configError).toBeUndefined();
  });

  it("preserves a valid provider-specific override", () => {
    const config = parseConfig({
      embedding: { ...validRemoteEmbedding, batchSize: 256 },
    });

    expect(config.embedding.enabled).toBe(true);
    expect(config.embedding.batchSize).toBe(256);
  });

  it.each([0, 1.5, 2049])("disables embedding for invalid batchSize %s", (batchSize) => {
    const config = parseConfig({
      embedding: { ...validRemoteEmbedding, batchSize },
    });

    expect(config.embedding.enabled).toBe(false);
    expect(config.embedding.batchSize).toBe(10);
    expect(config.embedding.configError).toContain("batchSize must be an integer between 1 and 2048");
  });
});
