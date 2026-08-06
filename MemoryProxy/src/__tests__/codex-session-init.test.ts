import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { handleSessionInit } from "../session/claude-code/init.js";
import { SessionStore } from "../session/store.js";

describe("Codex session initialization", () => {
  it("validates the Hub identity, registers under the codex namespace, and returns a Responses-ready context block", async () => {
    const store = new SessionStore();
    store.bind("codex:thread-1", {
      userId: "user-1",
      agentSource: "codex",
      sessionId: "thread-1",
      spaceId: "space-1",
    });
    const appendParticipationLog = vi.fn().mockResolvedValue(undefined);
    const metadataClient = {
      listTeams: vi.fn().mockResolvedValue([{ team_id: "team-1", name: "Platform" }]),
      listAgents: vi.fn().mockResolvedValue([{
        agent_id: "agent-1",
        name: "Release Engineer",
        description: "Owns release work",
      }]),
      listTasks: vi.fn().mockResolvedValue([{
        task_id: "task-1",
        title: "Ship Codex integration",
      }]),
      getAgent: vi.fn().mockResolvedValue({
        agent_id: "agent-1",
        name: "Release Engineer",
        description: "Owns release work",
        prompt: "Use the release workflow.",
      }),
      getTask: vi.fn().mockResolvedValue({
        task_id: "task-1",
        title: "Ship Codex integration",
        description: "Keep the Responses API native.",
      }),
      appendParticipationLog,
    };

    const result = await handleSessionInit(
      "thread-1",
      "user-1",
      [{ role: "user", content: "Please make this work." }],
      {
        ...DEFAULT_CONFIG.sessionInit,
        enabled: true,
        headerAutoSelect: {
          enabled: true,
          teamHeader: "x-team-id",
          agentHeader: "x-agent-id",
          taskHeader: "x-task-id",
          onMismatch: "bypass",
        },
      },
      store,
      { stream: true, modelId: "gpt-5.6-sol", protocol: "anthropic", agentSource: "codex" },
      metadataClient as never,
      "sk-mem-test",
      "space-1",
      { teamId: "team-1", agentId: "agent-1", taskId: "task-1" },
    );

    expect(result.bypassed).not.toBe(true);
    expect(result.sessionInfo).toMatchObject({
      session_id: "thread-1",
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
      user_id: "user-1",
      space_id: "space-1",
    });
    expect(result.systemAppend).toContain("<session_context>");
    expect(result.systemAppend).toContain("Release Engineer");
    expect(store.get("codex:thread-1")?.sessionInfo).toMatchObject({ agent_id: "agent-1" });
    expect(store.getBoundIdentity("codex:thread-1")).toMatchObject({ agentSource: "codex" });
    expect(appendParticipationLog).toHaveBeenCalledWith(expect.objectContaining({
      source: "context_proxy:codex",
      task_id: "task-1",
    }));
  });
});
