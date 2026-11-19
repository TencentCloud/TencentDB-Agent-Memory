import { describe, expect, it } from "vitest";
import {
  BRANCH_ENTRY_TYPE,
  branchIsolationEnabled,
  createBranchId,
  restoreBranchId,
} from "../branch-identity.js";

describe("Pi tree branch markers", () => {
  it("restores the newest valid v1 marker visible on the active branch", () => {
    expect(
      restoreBranchId([
        { type: "custom", customType: BRANCH_ENTRY_TYPE, data: { branchId: "branch-old" } },
        { type: "custom", customType: BRANCH_ENTRY_TYPE, data: { branchId: "bad value" } },
        { type: "custom", customType: BRANCH_ENTRY_TYPE, data: { branchId: "branch-current" } },
      ]),
    ).toBe("branch-current");
  });

  it("ignores malformed, unrelated, and future-version entries", () => {
    expect(
      restoreBranchId([
        { type: "custom", customType: BRANCH_ENTRY_TYPE, data: { branchId: "bad value" } },
        { type: "custom", customType: "other", data: { branchId: "branch-a" } },
        { type: "custom", customType: "tdai-memory/branch@2", data: { branchId: "branch-v2" } },
      ]),
    ).toBeUndefined();
  });

  it("creates safe, distinct marker ids", () => {
    const first = createBranchId();
    const second = createBranchId();
    expect(first).toMatch(/^branch-[A-Za-z0-9-]+$/);
    expect(second).toMatch(/^branch-[A-Za-z0-9-]+$/);
    expect(first).not.toBe(second);
  });

  it("supports an explicit opt-out while defaulting to enabled", () => {
    expect(branchIsolationEnabled(undefined)).toBe(true);
    expect(branchIsolationEnabled("1")).toBe(true);
    expect(branchIsolationEnabled("true")).toBe(true);
    expect(branchIsolationEnabled("0")).toBe(false);
    expect(branchIsolationEnabled("FALSE")).toBe(false);
    expect(branchIsolationEnabled("off")).toBe(false);
  });
});
