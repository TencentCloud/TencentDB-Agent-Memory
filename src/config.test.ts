import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("appends dynamic recall context by default for prefix-cache safety", () => {
    expect(parseConfig({}).recall.dynamicContextPlacement).toBe("append");
  });

  it("accepts legacy prepend placement for dynamic recall context", () => {
    expect(parseConfig({ recall: { dynamicContextPlacement: "prepend" } }).recall.dynamicContextPlacement).toBe("prepend");
  });

  it("falls back to append placement for invalid dynamic recall placement", () => {
    expect(parseConfig({ recall: { dynamicContextPlacement: "invalid" } }).recall.dynamicContextPlacement).toBe("append");
  });

  it("disables prompt shape diagnostics by default", () => {
    expect(parseConfig({}).recall.promptShapeDiagnostics).toBe(false);
  });

  it("enables prompt shape diagnostics through recall config", () => {
    expect(parseConfig({ recall: { promptShapeDiagnostics: true } }).recall.promptShapeDiagnostics).toBe(true);
  });

  it("strips injected recall from persisted history by default", () => {
    expect(parseConfig({}).recall.showInjected).toBe(false);
  });

  it("preserves injected recall when showInjected is enabled", () => {
    expect(parseConfig({ recall: { showInjected: true } }).recall.showInjected).toBe(true);
  });
});
