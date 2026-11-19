import { describe, expect, it } from "vitest";
import { isUserKeyExpired } from "./user-key.js";

/**
 * A malformed expires_at must fail closed (treated as expired). Otherwise a
 * corrupted/abnormally written expiry value turns a key into a credential that
 * never expires — a security issue. Only an absent value means "no expiry".
 */
describe("isUserKeyExpired — fail-closed on invalid dates", () => {
  const now = Date.parse("2026-11-18T00:00:00.000Z");

  it("returns false when expires_at is absent (null/undefined)", () => {
    expect(isUserKeyExpired(null, now)).toBe(false);
    expect(isUserKeyExpired(undefined, now)).toBe(false);
  });

  it("returns true for a valid past expiry", () => {
    expect(isUserKeyExpired("2026-01-01T00:00:00.000Z", now)).toBe(true);
  });

  it("returns false for a valid future expiry", () => {
    expect(isUserKeyExpired("2027-01-01T00:00:00.000Z", now)).toBe(false);
  });

  it("treats a valid expiry exactly equal to now as expired", () => {
    expect(isUserKeyExpired("2026-11-18T00:00:00.000Z", now)).toBe(true);
  });

  it("treats malformed / unparseable values as expired (fail-closed)", () => {
    for (const bad of ["not-a-date", "", "   ", "2026-13-99", "NaN"]) {
      expect(isUserKeyExpired(bad, now), `value: ${JSON.stringify(bad)}`).toBe(true);
    }
  });
});
