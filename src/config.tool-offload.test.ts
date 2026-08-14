import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("tool-result offload config", () => {
  it("provides bounded defaults and parses explicit limits", () => {
    const defaults = parseConfig({});
    expect(defaults.offload.inlineToolResultMaxTokens).toBe(1200);
    expect(defaults.offload.readChunkMaxTokens).toBe(1600);

    const configured = parseConfig({
      offload: {
        inlineToolResultMaxTokens: 64,
        summaryMaxTokens: 24,
        previewMaxChars: 320,
        readChunkMaxTokens: 512,
      },
    });
    expect(configured.offload.inlineToolResultMaxTokens).toBe(64);
    expect(configured.offload.summaryMaxTokens).toBe(24);
    expect(configured.offload.previewMaxChars).toBe(320);
    expect(configured.offload.readChunkMaxTokens).toBe(512);
  });
});
