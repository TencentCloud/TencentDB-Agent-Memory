import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";

describe("OpenAI-compatible model discovery", () => {
  it("serves public model aliases at the agent-scoped base URL", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      creditPricing: {
        models: [
          {
            name: "internal-gpt-id",
            modelName: "GPT Public",
            input: 1,
            output: 1,
            cacheRead: 1,
            cacheWrite5m: 1,
            cacheWrite1h: 1,
          },
          {
            name: "fallback-model",
            input: 1,
            output: 1,
            cacheRead: 1,
            cacheWrite5m: 1,
            cacheWrite1h: 1,
          },
        ],
      },
    };

    const app = createApp(config);
    const response = await app.request("/hermes/default/v1/models");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: "list",
      data: [
        { id: "GPT Public", object: "model", owned_by: "memorydb" },
        { id: "fallback-model", object: "model", owned_by: "memorydb" },
      ],
    });
  });

  it("returns an empty list when no pricing table is configured", async () => {
    const app = createApp(DEFAULT_CONFIG);
    const response = await app.request("/models");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ object: "list", data: [] });
  });
});
