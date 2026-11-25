import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config.js";
import { MetadataClient } from "../../meta/client.js";
import { handleSessionInit, SessionStore } from "../index.js";

function setup(skipAssetConfirm: boolean, agentSource = "dsh", hasTask = false) {
  const agent = { agent_id: "agent-a", name: "Review Agent" };
  const task = { task_id: "task-a", title: "Release review" };
  const fixture: Record<string, unknown> = {
    "/v3/meta/team/list": { items: [{ team_id: "team-a", name: "Engineering" }], total: 1 },
    "/v3/meta/agent/list": { items: [agent], total: 1 },
    "/v3/meta/task/list": hasTask ? { items: [task], total: 1 } : { items: [], total: 0 },
    "/v3/meta/task/get": task,
    "/v3/meta/agent/get": agent,
    "/v3/meta/user-session-default/get": null,
  };
  const metadata = new MetadataClient({
    endpoint: "http://metadata.test",
    serviceToken: "test-token",
    timeoutMs: 1000,
  }, "space-a", "user-key", async (input) => {
    const path = new URL(String(input)).pathname;
    if (!(path in fixture)) throw new Error(`Unexpected metadata request: ${path}`);
    return Response.json({ code: 0, data: fixture[path] });
  });
  const store = new SessionStore();
  const config = {
    ...DEFAULT_CONFIG.sessionInit!, enabled: true, skipAssetConfirm,
    defaultTaskId: hasTask ? undefined : DEFAULT_CONFIG.sessionInit?.defaultTaskId,
  };
  return (content: string) => handleSessionInit(
    "session-a", "user-a", [{ role: "user", content }], config, store,
    { protocol: "openai", stream: false, modelId: "test-model" },
    agentSource, metadata, "user-key", "space-a",
  );
}

describe("dsh auto-selection of a single binding", () => {
  it("provides a one-time notice with the selected team, agent and default task", async () => {
    const request = setup(true);
    const first = await request("Review this code.");
    expect(first.sessionInfo).toMatchObject({ team_id: "team-a", agent_id: "agent-a" });
    expect(first.defaultBindingNotice ?? "").toContain("Engineering (team-a)");
    expect(first.defaultBindingNotice ?? "").toContain("Review Agent (agent-a)");
    expect(first.defaultBindingNotice ?? "").toContain("default（不绑定任何 Task）");
    expect((await request("What changed?")).defaultBindingNotice).toBeFalsy();
  });

  it("also confirms the binding when the user agrees to associate team assets", async () => {
    const request = setup(false);
    expect((await request("Review this code.")).intercepted).toBe(true);
    const confirmed = await request("是，关联团队资产");
    expect(confirmed.sessionInfo).toMatchObject({ team_id: "team-a", agent_id: "agent-a" });
    expect(confirmed.defaultBindingNotice ?? "").toContain("Engineering (team-a)");
  });

  it("names the real task when it is the only available task", async () => {
    const result = await setup(true, "dsh", true)("Review this code.");
    expect(result.sessionInfo?.task_id).toBe("task-a");
    expect(result.defaultBindingNotice ?? "").toContain("Release review (task-a)");
  });

  it("preserves CodeBuddy behavior for the same auto-selection path", async () => {
    const result = await setup(true, "codebuddy")("Review this code.");
    expect(result.sessionInfo).toMatchObject({ team_id: "team-a", agent_id: "agent-a" });
    expect(result.defaultBindingNotice).toBeFalsy();
  });
});
