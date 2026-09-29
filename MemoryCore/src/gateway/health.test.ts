/**
 * Tests for GET /health status resolution (#1432).
 *
 * A store instance being present is not the same as the store working: the
 * sqlite store enters degraded mode (all operations silently no-op) when the
 * sqlite-vec extension fails to load or schema init fails. The health status
 * must reflect that instead of reporting "ok" whenever an object exists.
 */
import { describe, expect, it } from "vitest";
import { resolveHealthStatus } from "./health.js";

function storeWith(degraded: boolean): Pick<{ isDegraded(): boolean }, "isDegraded"> {
  return { isDegraded: () => degraded };
}

describe("resolveHealthStatus", () => {
  it('reports "ok" only for an existing, non-degraded store', () => {
    expect(resolveHealthStatus(storeWith(false))).toBe("ok");
  });

  it('reports "degraded" when the store exists but is in degraded no-op mode', () => {
    expect(resolveHealthStatus(storeWith(true))).toBe("degraded");
  });

  it('reports "degraded" when there is no store at all (previous behavior preserved)', () => {
    expect(resolveHealthStatus(undefined)).toBe("degraded");
  });
});
