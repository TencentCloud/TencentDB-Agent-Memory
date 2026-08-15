/**
 * Tests for #579 — hybrid recall must degrade to keyword-only when the
 * EmbeddingService is unavailable, instead of erroring every turn.
 */

import { describe, expect, it } from "vitest";
import { resolveEffectiveStrategy } from "./auto-recall.js";

describe("resolveEffectiveStrategy (#579)", () => {
  it("keeps keyword unchanged (with or without embeddings)", () => {
    expect(resolveEffectiveStrategy("keyword", false)).toBe("keyword");
    expect(resolveEffectiveStrategy("keyword", true)).toBe("keyword");
  });

  it("keeps hybrid when embeddings are available", () => {
    expect(resolveEffectiveStrategy("hybrid", true)).toBe("hybrid");
  });

  it("degrades hybrid to keyword when the EmbeddingService is unavailable", () => {
    expect(resolveEffectiveStrategy("hybrid", false)).toBe("keyword");
  });

  it("keeps embedding when embeddings are available", () => {
    expect(resolveEffectiveStrategy("embedding", true)).toBe("embedding");
  });

  it("throws for embedding when the EmbeddingService is unavailable", () => {
    expect(() => resolveEffectiveStrategy("embedding", false)).toThrow(/EmbeddingService/);
  });
});
