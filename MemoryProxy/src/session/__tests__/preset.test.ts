import { describe, it, expect } from "vitest";
import { resolvePresetIdentity } from "../preset.js";
import type { TeamOption } from "../types.js";

/**
 * resolvePresetIdentity — task-optional header registration.
 *
 * Context: task_id is an OPTIONAL business dimension in the TDAI kernel
 * (MemoryCore/src/core/store/isolation.ts: "taskId is an optional business
 * dimension for L0/L1 filtering"). The proxy over-strictly required a task
 * to register from headers (canRegister = agentId && taskId && !mismatch),
 * which silently dropped memory for any header-identity agent whose task
 * was absent or stale. This pins the relaxed semantics: team+agent is
 * enough to register; task is a stamp, not a gate.
 */
const team: TeamOption = {
  team_id: "team-1",
  team_name: "Team One",
  agents: [{ agent_id: "agt-1", agent_name: "Alpha" }],
  tasks: [
    { task_id: "task-1", task_name: "Real Task" },
  ],
};

describe("resolvePresetIdentity — task-optional registration", () => {
  it("registers when team + agent are valid, with a valid task (no change)", () => {
    const r = resolvePresetIdentity([team], {
      teamId: "team-1",
      agentId: "agt-1",
      taskId: "task-1",
    });
    expect(r.canRegister).toBe(true);
    expect(r.hadMismatch).toBe(false);
    expect(r).toMatchObject({ teamId: "team-1", agentId: "agt-1", taskId: "task-1" });
  });

  it("registers when team + agent are valid and NO task is provided (task-optional)", () => {
    const r = resolvePresetIdentity([team], {
      teamId: "team-1",
      agentId: "agt-1",
      // taskId omitted
    });
    expect(r.canRegister).toBe(true);
    expect(r.hadMismatch).toBe(false);
    expect(r.agentId).toBe("agt-1");
    expect(r.taskId).toBeUndefined();
  });

  it("registers with team+agent even when the provided task does NOT exist (stale task → broad recall, no block)", () => {
    const r = resolvePresetIdentity([team], {
      teamId: "team-1",
      agentId: "agt-1",
      taskId: "task-deleted-long-ago",
    });
    // Stale task must NOT block registration (agent is still valid).
    expect(r.canRegister).toBe(true);
    expect(r.agentId).toBe("agt-1");
    // Task is not echoed back (not found in the team's task list).
    expect(r.taskId).toBeUndefined();
  });

  it("still flags a mismatch (and does NOT register) when the AGENT is unknown", () => {
    const r = resolvePresetIdentity([team], {
      teamId: "team-1",
      agentId: "agt-does-not-exist",
      taskId: "task-1",
    });
    expect(r.canRegister).toBe(false);
    expect(r.hadMismatch).toBe(true);
  });

  it("still flags a mismatch when the TEAM is unknown", () => {
    const r = resolvePresetIdentity([team], {
      teamId: "team-other",
      agentId: "agt-1",
    });
    expect(r.canRegister).toBe(false);
    expect(r.hadMismatch).toBe(true);
    expect(r.teamId).toBeUndefined();
  });

  it("returns canRegister=false with no mismatch when only the team is provided (agent missing)", () => {
    const r = resolvePresetIdentity([team], { teamId: "team-1" });
    expect(r.canRegister).toBe(false);
    expect(r.hadMismatch).toBe(false);
    expect(r.teamId).toBe("team-1");
  });
});
