import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("parseConfig recall.showInjected", () => {
  it("defaults to false to avoid persisting dynamic recall context", () => {
    expect(parseConfig({}).recall.showInjected).toBe(false);
  });

  it("accepts explicit opt-in for persisted injected context inspection", () => {
    expect(parseConfig({ recall: { showInjected: true } }).recall.showInjected).toBe(true);
  });
});
