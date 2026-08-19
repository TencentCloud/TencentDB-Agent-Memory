import { describe, expect, it } from "vitest";
import { BRANCH_ENTRY_TYPE, memorySessionId, restoreBranchId } from "../src/session.js";

describe("tree branch memory identity", () => {
  it("restores the newest valid marker visible on the active branch", () => {
    expect(
      restoreBranchId([
        { type: "custom", customType: BRANCH_ENTRY_TYPE, data: { branchId: "branch-old" } },
        { type: "custom", customType: BRANCH_ENTRY_TYPE, data: { branchId: "bad value" } },
        { type: "custom", customType: BRANCH_ENTRY_TYPE, data: { branchId: "branch-current" } },
      ]),
    ).toBe("branch-current");
  });

  it("does not trust malformed or unrelated persisted entries", () => {
    expect(restoreBranchId([{ type: "custom", customType: BRANCH_ENTRY_TYPE, data: { branchId: "bad value" } }])).toBeUndefined();
    expect(restoreBranchId([{ type: "custom", customType: "other", data: { branchId: "branch-a" } }])).toBeUndefined();
  });

  it("keeps forks and sibling branches in separate Memory sessions", () => {
    expect(memorySessionId("fork-a", "branch-left")).not.toBe(memorySessionId("fork-b", "branch-left"));
    expect(memorySessionId("session-a", "branch-left")).not.toBe(memorySessionId("session-a", "branch-right"));
  });
});
