import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("recall injection config", () => {
  it("uses memory epochs by default", () => {
    expect(parseConfig({}).recall.injectionMode).toBe("epoch");
    expect(parseConfig({}).recall.epochMaxTokens).toBe(8192);
  });

  it.each(["append", "prepend"] as const)("accepts %s injection", (injectionMode) => {
    expect(parseConfig({ recall: { injectionMode } }).recall.injectionMode).toBe(injectionMode);
  });

  it("accepts a bounded memory epoch token budget", () => {
    expect(parseConfig({ recall: { epochMaxTokens: 4096 } }).recall.epochMaxTokens).toBe(4096);
    expect(parseConfig({ recall: { epochMaxTokens: 12 } }).recall.epochMaxTokens).toBe(256);
  });

  it("does not accept unknown injection modes", () => {
    expect(parseConfig({ recall: { injectionMode: "suffix" } }).recall.injectionMode).toBe("epoch");
  });
});
