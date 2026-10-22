import { describe, expect, it } from "vitest";
import {
  memoryStoreHealth,
  overallHealthStatus,
} from "./health.js";

describe("gateway health", () => {
  it("distinguishes missing, degraded, and healthy stores", () => {
    expect(memoryStoreHealth()).toBe("missing");
    expect(memoryStoreHealth({ isDegraded: () => true })).toBe("degraded");
    expect(memoryStoreHealth({ isDegraded: () => false })).toBe("ok");
  });

  it("marks the overall service degraded when the store exists but no-ops", () => {
    expect(overallHealthStatus()).toBe("degraded");
    expect(overallHealthStatus({ isDegraded: () => true })).toBe("degraded");
    expect(overallHealthStatus({ isDegraded: () => false })).toBe("ok");
  });
});
