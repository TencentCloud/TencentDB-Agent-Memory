import { describe, expect, it } from "vitest";
import { resolvePresetIdentity } from "../preset.js";

const teams = [{
  team_id: "team-1", team_name: "Team",
  agents: [{ agent_id: "agent-1", agent_name: "Agent" }],
  tasks: [{ task_id: "task-1", task_name: "Task" }],
}];

describe("resolvePresetIdentity task policy", () => {
  it("preserves the legacy explicit team+agent+task path", () => {
    const result = resolvePresetIdentity(teams, { teamId: "team-1", agentId: "agent-1", taskId: "task-1" }, { taskMissingPolicy: "skip" });
    expect(result).toMatchObject({ canRegister: true, teamId: "team-1", agentId: "agent-1", taskId: "task-1", hadMismatch: false });
  });

  it("registers team+agent without a task in skip mode", () => {
    const result = resolvePresetIdentity(teams, { teamId: "team-1", agentId: "agent-1" }, { taskMissingPolicy: "skip" });
    expect(result).toMatchObject({ canRegister: true, hadMismatch: false });
    expect(result.taskId).toBeUndefined();
  });

  it("uses defaultTaskId in default mode", () => {
    const result = resolvePresetIdentity(teams, { teamId: "team-1", agentId: "agent-1" }, { taskMissingPolicy: "default", defaultTaskId: "default" });
    expect(result).toMatchObject({ canRegister: true, taskId: "default", hadMismatch: false });
  });

  it("rejects a missing task in reject mode", () => {
    const result = resolvePresetIdentity(teams, { teamId: "team-1", agentId: "agent-1" }, { taskMissingPolicy: "reject" });
    expect(result).toMatchObject({ canRegister: false, hadMismatch: true });
  });

  it("treats a provided invalid task as mismatch instead of silently dropping it", () => {
    const result = resolvePresetIdentity(teams, { teamId: "team-1", agentId: "agent-1", taskId: "stale" }, { taskMissingPolicy: "skip" });
    expect(result).toMatchObject({ canRegister: false, hadMismatch: true });
  });
});
