import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("task-aware recall selector config", () => {
  it("is disabled by default", () => {
    expect(parseConfig({}).recall.taskSelector).toEqual({
      enabled: false,
      candidateMultiplier: 3,
      timeoutMs: 3000,
      model: undefined,
    });
  });

  it("parses explicit selector settings", () => {
    const cfg = parseConfig({
      recall: {
        taskSelector: {
          enabled: true,
          candidateMultiplier: 4,
          timeoutMs: 2500,
          model: "openai/gpt-4o-mini",
        },
      },
    });

    expect(cfg.recall.taskSelector).toEqual({
      enabled: true,
      candidateMultiplier: 4,
      timeoutMs: 2500,
      model: "openai/gpt-4o-mini",
    });
  });
});
