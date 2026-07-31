import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("recall injection config", () => {
  it("uses memory epochs by default", () => {
    expect(parseConfig({}).recall.injectionMode).toBe("epoch");
    expect(parseConfig({}).recall.epochMaxTokens).toBe(8192);
  });

  it("accepts append injection", () => {
    expect(parseConfig({ recall: { injectionMode: "append" } }).recall.injectionMode).toBe("append");
  });

  it("accepts prepend injection", () => {
    expect(parseConfig({ recall: { injectionMode: "prepend" } }).recall.injectionMode).toBe("prepend");
  });

  it("accepts a bounded memory epoch token budget", () => {
    expect(parseConfig({ recall: { epochMaxTokens: 4096 } }).recall.epochMaxTokens).toBe(4096);
    expect(parseConfig({ recall: { epochMaxTokens: 12 } }).recall.epochMaxTokens).toBe(256);
  });

  it("does not accept unknown injection modes", () => {
    expect(parseConfig({ recall: { injectionMode: "suffix" } }).recall.injectionMode).toBe("epoch");
  });
});
