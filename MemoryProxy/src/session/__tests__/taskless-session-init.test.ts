import { describe, expect, it, vi } from "vitest";

import type { MetadataClient } from "../../meta/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import { recordTdaiTurn } from "../../tdai/recorder.js";
import type { TdaiClient } from "../../tdai/client.js";
import { SessionStore } from "../store.js";
import { handleSessionInit as handleClaudeSessionInit } from "../claude-code/init.js";
import { handleSessionInit as handleCodeBuddySessionInit } from "../codebuddy/init.js";

const userId = "usr-test";
const sessionKey = "session-taskless";

function metadataClient(options: {
  agents?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
} = {}): MetadataClient {
  return {
    listTeams: vi.fn().mockResolvedValue([
      { team_id: "team-test", name: "Team test" },
    ]),
    listAgents: vi.fn().mockResolvedValue(options.agents ?? [
      { agent_id: "agt-test", name: "Agent test" },
    ]),
    listTasks: vi.fn().mockResolvedValue(options.tasks ?? []),
    getAgent: vi.fn().mockResolvedValue({
      agent_id: "agt-test",
      name: "Agent test",
      description: "test agent",
    }),
    getTask: vi.fn().mockResolvedValue({
      task_id: "task-test",
      title: "Task test",
    }),
  } as unknown as MetadataClient;
}

const config = {
  enabled: true,
  maxRetries: 3,
} as any;

const claudeRequest = {
  stream: false,
  modelId: "test-model",
  protocol: "anthropic" as const,
};

const codeBuddyRequest = {
  stream: false,
  modelId: "test-model",
  protocol: "openai" as const,
};

describe("taskless interactive session initialization", () => {
  it("keeps a Claude Code team+agent session initialized when the team has no tasks", async () => {
    const store = new SessionStore();
    const client = metadataClient();

    const first = await handleClaudeSessionInit(
      sessionKey,
      userId,
      [{ role: "user", content: "start" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );
    expect(first.intercepted).toBe(true);

    const completed = await handleClaudeSessionInit(
      sessionKey,
      userId,
      [{ role: "user", content: "是，关联团队资产" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );

    expect(completed.bypassed).not.toBe(true);
    expect(completed.sessionInfo).toMatchObject({
      team_id: "team-test",
      agent_id: "agt-test",
      user_id: userId,
      session_id: sessionKey,
    });
    expect(completed.sessionInfo?.task_id).toBeUndefined();
    expect(store.get(`claude-code:${sessionKey}`)?.bypassed).not.toBe(true);

    const identity = deriveTdaiIdentity({
      sessionInfo: completed.sessionInfo as unknown as Record<string, unknown>,
      sessionKey,
      userKey: "sk-mem-test",
    });
    expect(identity).not.toBeNull();
    expect(identity?.taskId).toBeUndefined();
    const addConversation = vi.fn();
    await recordTdaiTurn(
      { addConversation } as unknown as TdaiClient,
      identity,
      { role: "user", content: "remember this" },
      "acknowledged",
    );
    expect(addConversation).toHaveBeenCalledOnce();
  });

  it("keeps a CodeBuddy team+agent session initialized when the team has no tasks", async () => {
    const store = new SessionStore();
    const client = metadataClient();

    const first = await handleCodeBuddySessionInit(
      sessionKey,
      userId,
      [{ role: "user", content: "start" }],
      config,
      store,
      codeBuddyRequest,
      client,
      "sk-mem-test",
      "space-test",
    );
    expect(first.intercepted).toBe(true);

    const completed = await handleCodeBuddySessionInit(
      sessionKey,
      userId,
      [{ role: "user", content: "是，关联团队资产" }],
      config,
      store,
      codeBuddyRequest,
      client,
      "sk-mem-test",
      "space-test",
    );

    expect(completed.bypassed).not.toBe(true);
    expect(completed.sessionInfo).toMatchObject({
      team_id: "team-test",
      agent_id: "agt-test",
      user_id: userId,
      session_id: sessionKey,
    });
    expect(completed.sessionInfo?.task_id).toBeUndefined();
    expect(store.get(`codebuddy:${sessionKey}`)?.bypassed).not.toBe(true);
  });

  it("keeps the existing single-task auto-selection behavior", async () => {
    const store = new SessionStore();
    const client = metadataClient({
      tasks: [{ task_id: "task-test", title: "Task test" }],
    });

    await handleClaudeSessionInit(
      "session-one-task",
      userId,
      [{ role: "user", content: "start" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );
    const completed = await handleClaudeSessionInit(
      "session-one-task",
      userId,
      [{ role: "user", content: "是，关联团队资产" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );

    expect(completed.bypassed).not.toBe(true);
    expect(completed.sessionInfo?.task_id).toBe("task-test");
  });

  it("keeps task selection for teams with multiple tasks", async () => {
    const store = new SessionStore();
    const client = metadataClient({
      tasks: [
        { task_id: "task-one", title: "Task one" },
        { task_id: "task-two", title: "Task two" },
      ],
    });

    await handleClaudeSessionInit(
      "session-many-tasks",
      userId,
      [{ role: "user", content: "start" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );
    const pending = await handleClaudeSessionInit(
      "session-many-tasks",
      userId,
      [{ role: "user", content: "是，关联团队资产" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );

    expect(pending.intercepted).toBe(true);
    expect(pending.bypassed).not.toBe(true);
    expect(store.get("claude-code:session-many-tasks")?.status).toBe("pending_task_select");
  });

  it("preserves an explicit user request to skip team assets", async () => {
    const store = new SessionStore();
    const client = metadataClient();

    await handleClaudeSessionInit(
      "session-skip-assets",
      userId,
      [{ role: "user", content: "start" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );
    const skipped = await handleClaudeSessionInit(
      "session-skip-assets",
      userId,
      [{ role: "user", content: "否，本次不关联" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );

    expect(skipped.bypassed).toBe(true);
    expect(store.get("claude-code:session-skip-assets")?.bypassed).toBe(true);
  });

  it("keeps defaultTaskId semantics when no real tasks exist", async () => {
    const store = new SessionStore();
    const client = metadataClient();
    const defaultTaskConfig = { ...config, defaultTaskId: "default-task" };

    await handleClaudeSessionInit(
      "session-default-task",
      userId,
      [{ role: "user", content: "start" }],
      defaultTaskConfig,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );
    const completed = await handleClaudeSessionInit(
      "session-default-task",
      userId,
      [{ role: "user", content: "是，关联团队资产" }],
      defaultTaskConfig,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );

    expect(completed.bypassed).not.toBe(true);
    expect(completed.sessionInfo?.task_id).toBe("default-task");
  });

  it("preserves the no-active-agent bypass", async () => {
    const store = new SessionStore();
    const client = metadataClient({ agents: [] });

    const result = await handleClaudeSessionInit(
      "session-no-agent",
      userId,
      [{ role: "user", content: "start" }],
      config,
      store,
      claudeRequest,
      client,
      "sk-mem-test",
      "space-test",
    );

    expect(result.bypassed).toBe(true);
    expect(store.get("claude-code:session-no-agent")?.bypassed).toBe(true);
  });
});
