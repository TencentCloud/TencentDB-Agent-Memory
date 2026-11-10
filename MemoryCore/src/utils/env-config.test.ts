import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEY = "MEMORY_OFFLOAD_MAX_BODY_BYTES";

async function load() {
  return await import("./env-config.js");
}

describe("resolveOffloadMaxBodyBytes", () => {
  const original = process.env[KEY];

  beforeEach(() => {
    vi.resetModules();
    delete process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("falls back to the 32 MiB default when unset", async () => {
    delete process.env[KEY];
    const { resolveOffloadMaxBodyBytes } = await load();
    expect(resolveOffloadMaxBodyBytes()).toBe(32 * 1024 * 1024);
  });

  it("honors a positive integer override", async () => {
    process.env[KEY] = "67108864";
    const { resolveOffloadMaxBodyBytes } = await load();
    expect(resolveOffloadMaxBodyBytes()).toBe(64 * 1024 * 1024);
  });

  it("rejects zero, negatives, and non-numeric values", async () => {
    for (const raw of ["0", "-1", "abc", ""]) {
      vi.resetModules();
      process.env[KEY] = raw;
      const { resolveOffloadMaxBodyBytes } = await load();
      expect(resolveOffloadMaxBodyBytes()).toBe(32 * 1024 * 1024);
    }
  });
});
