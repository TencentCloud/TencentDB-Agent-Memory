import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig recall.showInjected", () => {
  it("defaults to false", () => {
    expect(parseConfig({}).recall.showInjected).toBe(false);
  });

  it("accepts explicit true", () => {
    expect(parseConfig({ recall: { showInjected: true } }).recall.showInjected).toBe(true);
  });
});
