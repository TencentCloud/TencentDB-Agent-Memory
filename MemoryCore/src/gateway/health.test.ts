import { describe, expect, it } from "vitest";
import { getStoreHealth } from "./health.js";

describe("getStoreHealth", () => {
  it("reports unavailable when no store was initialized", () => {
    expect(getStoreHealth(undefined)).toEqual({ status: "unavailable" });
  });

  it("reports an initialized, usable store as ok", () => {
    expect(getStoreHealth({ isDegraded: () => false })).toEqual({ status: "ok" });
  });

  it("reports a degraded store and exposes its safe initialization reason", () => {
    expect(getStoreHealth({
      isDegraded: () => true,
      getDegradedReason: () => "sqlite-vec load failed: extension missing",
    })).toEqual({
      status: "degraded",
      reason: "sqlite-vec load failed: extension missing",
    });
  });

  it("does not require older store implementations to expose a reason", () => {
    expect(getStoreHealth({ isDegraded: () => true })).toEqual({ status: "degraded" });
  });
});
