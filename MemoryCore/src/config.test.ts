/**
 * Tests for #678 — parseConfig must accept provider="local" for fully-offline
 * embedding (node-llama-cpp), instead of coercing it to "none" + disabled.
 */

import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig embedding provider (#678)", () => {
  it("defaults to provider=none (embedding disabled)", () => {
    const cfg = parseConfig({});
    expect(cfg.embedding.provider).toBe("none");
    expect(cfg.embedding.enabled).toBe(false);
  });

  it("keeps provider=none disabled when explicitly set", () => {
    const cfg = parseConfig({ embedding: { provider: "none" } });
    expect(cfg.embedding.provider).toBe("none");
    expect(cfg.embedding.enabled).toBe(false);
  });

  it("enables embedding when provider=local (offline, no apiKey)", () => {
    const cfg = parseConfig({ embedding: { provider: "local" } });
    expect(cfg.embedding.provider).toBe("local");
    expect(cfg.embedding.enabled).toBe(true);
  });
});
