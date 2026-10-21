/**
 * Tests for #709 — parseConfig must read the LLM wire protocol
 * (`llm.protocol`): "anthropic" → native Anthropic, anything else → "openai".
 */

import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig llm.protocol (#709)", () => {
  it("defaults to openai when llm block is absent", () => {
    const cfg = parseConfig({});
    expect(cfg.llm.protocol).toBe("openai");
  });

  it("parses protocol=anthropic", () => {
    const cfg = parseConfig({ llm: { protocol: "anthropic" } });
    expect(cfg.llm.protocol).toBe("anthropic");
  });

  it("coerces unknown protocol values to openai (backward compatible)", () => {
    const cfg = parseConfig({ llm: { protocol: "not-a-protocol" } });
    expect(cfg.llm.protocol).toBe("openai");
  });
});
