import { describe, expect, it } from "vitest";
import {
  sanitizeSessionKey,
  SessionResolver,
} from "../src/session-resolver.js";

describe("SessionResolver", () => {
  it("prioritizes tool and configured session keys", () => {
    const resolver = new SessionResolver({
      cwd: process.cwd(),
      explicitSessionKey: "configured key",
    });
    expect(resolver.resolve("session", "tool key")).toBe("tool-key");
    expect(resolver.resolve("session")).toBe("configured-key");
  });

  it("derives stable distinct OpenCode session keys", () => {
    const resolver = new SessionResolver({ cwd: process.cwd() });
    expect(resolver.resolve("one")).toBe(resolver.resolve("one"));
    expect(resolver.resolve("one")).not.toBe(resolver.resolve("two"));
    expect(resolver.resolve("one")).toMatch(/^opencode:/);
  });

  it("sanitizes and bounds keys", () => {
    const key = sanitizeSessionKey(` unsafe / ${"x".repeat(300)}`);
    expect(key).toMatch(/^[a-zA-Z0-9._:-]+$/);
    expect(key.length).toBeLessThanOrEqual(160);
  });
});
