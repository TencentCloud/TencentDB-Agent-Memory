import { describe, expect, it, vi } from "vitest";
import type { MetadataClient } from "../../../meta/client.js";
import type { SessionInitConfig } from "../../../types.js";
import { resolveDshHeadlessMemoryIdentity } from "../headless-memory.js";

const config: SessionInitConfig = {
  enabled: true,
  maxRetries: 3,
  headerAutoSelect: {
    enabled: true,
    teamHeader: "x-team-id",
    agentHeader: "x-agent-id",
    taskHeader: "x-task-id",
    onMismatch: "form",
  },
};

function metadataClient(overrides: Partial<MetadataClient> = {}): MetadataClient {
  return {
    listTeams: vi.fn().mockResolvedValue([{ team_id: "team-1", name: "Team 1" }]),
    listAgents: vi.fn().mockResolvedValue([{ agent_id: "agent-1", team_id: "team-1", name: "Agent 1" }]),
    listTasks: vi.fn().mockResolvedValue([{ task_id: "task-1", team_id: "team-1", title: "Task 1" }]),
    ...overrides,
  } as unknown as MetadataClient;
}

describe("resolveDshHeadlessMemoryIdentity", () => {
  it("validates headers and builds a memory identity without a form", async () => {
    const client = metadataClient();
    const result = await resolveDshHeadlessMemoryIdentity({
      config,
      headers: {
        "x-team-id": "team-1",
        "x-agent-id": "agent-1",
        "x-task-id": "task-1",
      },
      metadataClient: client,
      userId: "user-1",
      userKey: "user-key",
      sessionKey: "session-1",
      spaceId: "space-1",
    });

    expect(result).toMatchObject({
      team_id: "team-1",
      agent_id: "agent-1",
      task_id: "task-1",
      user_id: "user-1",
      session_id: "session-1",
      space_id: "space-1",
    });
    expect(client.listTeams).toHaveBeenCalledWith("user-1");
    expect(client.listAgents).toHaveBeenCalledWith("team-1", "user-1");
  });

  it("rejects a team or agent outside the authenticated user's scope", async () => {
    await expect(resolveDshHeadlessMemoryIdentity({
      config,
      headers: { "x-team-id": "team-other", "x-agent-id": "agent-1" },
      metadataClient: metadataClient(),
      userId: "user-1",
      sessionKey: "session-1",
    })).resolves.toBeNull();

    await expect(resolveDshHeadlessMemoryIdentity({
      config,
      headers: { "x-team-id": "team-1", "x-agent-id": "agent-other" },
      metadataClient: metadataClient(),
      userId: "user-1",
      sessionKey: "session-1",
    })).resolves.toBeNull();
  });

  it("requires team and agent headers and does not use debug identity", async () => {
    const client = metadataClient();
    await expect(resolveDshHeadlessMemoryIdentity({
      config: {
        ...config,
        debugForceIdentity: {
          team_id: "team-1",
          agent_id: "agent-1",
          task_id: "task-1",
        },
      },
      headers: {},
      metadataClient: client,
      userId: "user-1",
      sessionKey: "session-1",
    })).resolves.toBeNull();
    expect(client.listTeams).not.toHaveBeenCalled();
  });

  it("drops a stale optional task while preserving team and agent", async () => {
    const result = await resolveDshHeadlessMemoryIdentity({
      config,
      headers: {
        "x-team-id": "team-1",
        "x-agent-id": "agent-1",
        "x-task-id": "task-stale",
      },
      metadataClient: metadataClient(),
      userId: "user-1",
      sessionKey: "session-1",
    });

    expect(result?.task_id).toBeUndefined();
  });
});
