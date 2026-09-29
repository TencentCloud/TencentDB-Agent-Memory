import { describe, expect, it, vi } from "vitest";
import { handleSessionInit } from "../session/claude-code/init.js";
import { SessionStore } from "../session/store.js";
import type { MetadataClient } from "../meta/client.js";
import type { SessionInitConfig } from "../types.js";
import type { PresetIdentity } from "../session/preset.js";
const config: SessionInitConfig = { enabled: true, maxRetries: 3,
  headerAutoSelect: { enabled: true, teamHeader: "x-team-id", agentHeader: "x-agent-id", taskHeader: "x-task-id", onMismatch: "form" } };
function fixture(unrelatedFailure = false) {
  const client = {
    listTeams: vi.fn(async () => [{ team_id: "target", name: "Target" }, { team_id: "other", name: "Other" }]),
    listAgents: vi.fn(async (teamId: string, _userId: string) => {
      if (teamId === "other" && unrelatedFailure) throw new Error("unrelated directory timeout");
      return [{ agent_id: `${teamId}-agent`, name: "Agent" }];
    }),
    listTasks: vi.fn(async (teamId: string) => [{ task_id: `${teamId}-task`, title: "Task" }]),
    getAgent: vi.fn(async (agentId: string) => ({ agent_id: agentId, name: "Agent" })),
    getTask: vi.fn(async (taskId: string) => ({ task_id: taskId, title: "Task" })),
  };
  const store = new SessionStore();
  const run = (preset?: PresetIdentity, cfg = config) => handleSessionInit("session", "user", [{ role: "user", content: "hello" }], cfg, store,
    { stream: false, modelId: "test", protocol: "anthropic" }, client as unknown as MetadataClient, undefined, undefined, preset);
  return { client, store, run };
}
describe("Claude Code preset directory scope", () => {
  it("registers a visible target without reading an unrelated failing directory", async () => {
    const { client, store, run } = fixture(true);
    const result = await run({ teamId: "target", agentId: "target-agent", taskId: "target-task" });
    expect(result.bypassed).not.toBe(true);
    expect(store.get("claude-code:session")?.sessionInfo).toMatchObject({ team_id: "target", agent_id: "target-agent", task_id: "target-task" });
    expect(client.listTeams).toHaveBeenCalledWith("user");
    expect(client.listAgents.mock.calls).toEqual([["target", "user"]]);
    expect(client.listTasks.mock.calls).toEqual([["target"]]);
  });
  it("limits team-only preselection to the visible target", async () => {
    const { client, store, run } = fixture(true);
    await run({ teamId: "target" });
    expect(store.get("claude-code:session")?.sessionInfo?.agent_id).toBe("target-agent");
    expect(client.listAgents.mock.calls).toEqual([["target", "user"]]);
  });
  it.each([{ teamId: "hidden", agentId: "hidden-agent" }, { teamId: "target", agentId: "other-agent" }])("keeps the full form catalogue for mismatch %j", async (preset) => {
    const { client, store, run } = fixture();
    const result = await run(preset);
    expect(result.intercepted).toBe(true);
    expect(store.get("claude-code:session")?.sessionInfo).toBeFalsy();
    expect(store.get("claude-code:session")?.cachedTeams?.map(t => t.team_id)).toEqual(["target", "other"]);
    expect(client.getAgent).not.toHaveBeenCalled();
    expect(client.listAgents.mock.calls).toEqual([["target", "user"], ["other", "user"]]);
  });
  it("keeps mismatch bypass and never loads an invisible team", async () => {
    const { client, run } = fixture();
    const result = await run({ teamId: "hidden", agentId: "hidden-agent" }, { ...config, headerAutoSelect: { ...config.headerAutoSelect!, onMismatch: "bypass" } });
    expect(result.bypassed).toBe(true);
    expect(client.getAgent).not.toHaveBeenCalled();
    expect(client.listAgents.mock.calls.every(([team]) => team !== "hidden")).toBe(true);
  });
  it("rejects a foreign agent without loading unrelated directories in bypass mode", async () => {
    const { client, run } = fixture(true);
    const result = await run({ teamId: "target", agentId: "other-agent" }, { ...config, headerAutoSelect: { ...config.headerAutoSelect!, onMismatch: "bypass" } });
    expect(result.bypassed).toBe(true);
    expect(client.getAgent).not.toHaveBeenCalled();
    expect(client.listAgents.mock.calls).toEqual([["target", "user"]]);
  });
  it("preserves optional stale-task behavior without widening the directory read", async () => {
    const { client, store, run } = fixture(true);
    await run({ teamId: "target", agentId: "target-agent", taskId: "other-task" });
    expect(store.get("claude-code:session")?.sessionInfo?.agent_id).toBe("target-agent");
    expect(store.get("claude-code:session")?.sessionInfo?.task_id).toBeFalsy();
    expect(client.getTask).not.toHaveBeenCalled();
    expect(client.listAgents.mock.calls).toEqual([["target", "user"]]);
  });
  it.each([true, false])("keeps the full catalogue without effective preselection (enabled=%s)", async (enabled) => {
    const { client, run } = fixture();
    await run(enabled ? undefined : { teamId: "target", agentId: "target-agent" }, { ...config, headerAutoSelect: { ...config.headerAutoSelect!, enabled } });
    expect(client.listAgents.mock.calls).toEqual([["target", "user"], ["other", "user"]]);
  });
});
