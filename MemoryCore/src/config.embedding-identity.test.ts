import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("embedding schema identity configuration", () => {
  it("keeps stable schema fields separate from the runtime model alias", () => {
    const config = parseConfig({
      embedding: {
        enabled: true,
        provider: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "local",
        model: "bge-m3-runtime-8k",
        schemaIdentity: "bge-m3",
        modelRevision: "2024-01",
        normalization: "l2-v1",
        dimensions: 1024,
      },
    });
    expect(config.embedding).toMatchObject({
      model: "bge-m3-runtime-8k",
      schemaIdentity: "bge-m3",
      modelRevision: "2024-01",
      normalization: "l2-v1",
      dimensions: 1024,
    });
  });
});
