import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getSessionRepo, type SessionRepo } from "../../db/sessionRepo.js";
import { MetadataClient, setMetadataClient, type TaskEntity } from "../../meta/client.js";
import { _resetPendingStoreForTests } from "../../mem-command/pending-store.js";
import { stageSessionInitOrchestrate } from "../../pipeline/stages/session-init-orchestrate.js";
import { handleSessionInit } from "../../session/claude-code/init.js";
import { handleSessionInit as handleCodeBuddySessionInit } from "../../session/codebuddy/init.js";
import { __resetSessionStoreForTests, getSessionStore, SessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";
import type { ProxyConfig } from "../../types.js";
import { cancelPendingTaskAction, confirmPendingTaskAction, updateTaskFromSession } from "../session-task.js";

// Keep the actual SessionStore, without touching a developer's local database.
vi.mock("../../db/sessionRepo.js", () => ({ getSessionRepo: vi.fn() }));

const config = {
  coreSkill: { endpoint: "http://kernel.test", serviceToken: "test-token", timeoutMs: 1000 },
  sessionInit: { enabled: true, maxRetries: 3 },
} as ProxyConfig;

let task: TaskEntity;
let client: MetadataClient;
const input = { sessionKey: "session-a", agentSource: "claude-code", config, spaceId: "space-a" };

async function draftUpdate() {
  return updateTaskFromSession({ ...input, directDescription: "TASK_DESC_V2", recentMessages: [] });
}

async function nextContext(store = getSessionStore()) {
  const next = await handleSessionInit(
    "session-a", "user-a", [{ role: "user", content: "Continue" }],
    config.sessionInit, store, { stream: false, modelId: "test-model" },
  );
  return JSON.stringify(next.messages);
}

beforeEach(async () => {
  __resetSessionStoreForTests();
  _resetPendingStoreForTests();
  task = {
    task_id: "task-a", team_id: "team-a", creator_user_id: "user-a",
    title: "Task A", description: "TASK_DESC_V1", status: "running",
  };
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/task/update")) {
      task = { ...task, ...JSON.parse(String(init?.body)) };
    } else if (!String(url).endsWith("/task/get")) {
      throw new Error(`Unexpected metadata request: ${url}`);
    }
    return Response.json({ code: 0, data: { ...task } });
  };
  client = new MetadataClient(config.coreSkill, "space-a", "test-key", fetcher);
  setMetadataClient(client);
  await getSessionStore().set("claude-code:session-a", {
    status: "initialized", keyId: "claude-code:session-a", startedAt: 1, attemptCount: 0,
    sessionInfo: {
      session_id: "session-a", team_id: "team-a", agent_id: "agent-a",
      user_id: "user-a", task_id: task.task_id, space_id: "space-a", user_key: "test-key",
    },
    taskDetail: { id: task.task_id, name: task.title, description: task.description ?? undefined },
  });
});

afterEach(() => {
  setMetadataClient(null);
  __resetSessionStoreForTests();
  _resetPendingStoreForTests();
  vi.restoreAllMocks();
  vi.mocked(getSessionRepo).mockReset();
});

it.each([
  ["claude-code", "openai"],
  ["claude-code", "anthropic"],
  ["codebuddy", "openai"],
] as const)("injects the confirmed description on the next %s/%s turn", async (agentSource, protocol) => {
  const store = getSessionStore();
  if (agentSource !== "claude-code") {
    await store.set(`${agentSource}:session-a`, store.get("claude-code:session-a")!);
  }
  const input = { sessionKey: "session-a", agentSource, config, spaceId: "space-a" };
  const draft = await updateTaskFromSession({ ...input, directDescription: "TASK_DESC_V2", recentMessages: [] });
  expect(draft, JSON.stringify(draft)).toHaveProperty("pending.kind", "update");
  const confirmed = await confirmPendingTaskAction(input);
  expect(confirmed.success).toBe(true);
  expect(task.description).toBe("TASK_DESC_V2");
  expect(confirmed.description).toBe("TASK_DESC_V2");

  const messages = [{ role: "user", content: "Continue" }];
  const reqCtx = { stream: false, modelId: "test-model", protocol };
  const next = agentSource === "claude-code"
    ? await handleSessionInit("session-a", "user-a", messages, config.sessionInit, store, reqCtx)
    : await handleCodeBuddySessionInit("session-a", "user-a", messages, config.sessionInit, store, reqCtx);
  const context = protocol === "anthropic" && "systemAppend" in next
    ? next.systemAppend ?? "" : JSON.stringify(next.messages);
  expect(context).toContain("TASK_DESC_V2");
  expect(context).not.toContain("TASK_DESC_V1");
});

it("passes the updated task snapshot to the pipeline recovery callback", async () => {
  await draftUpdate();
  expect((await confirmPendingTaskAction(input)).success).toBe(true);
  const messages = [{ role: "user", content: "Continue" }];
  const buildRecoverInitResult = vi.fn((_state: SessionInitState) => ({ messages }));
  const result = await stageSessionInitOrchestrate({
    agentSourceForState: input.agentSource, sessionKey: "session-a", userId: "user-a",
    spaceId: "space-a", config, kernelUserKey: "test-key", headers: {},
    recoveryMessages: messages, synthesizeMessages: () => messages,
    buildReqCtx: () => ({ stream: false, modelId: "test-model" }),
    buildInterceptResponse: (init) => init.response ?? null,
    buildRecoverInitResult,
  });
  expect(result.proceed).toBe(true);
  expect(result.wentThroughStateMachine).toBe(false);
  expect(buildRecoverInitResult).toHaveBeenCalledWith(
    expect.objectContaining({
      taskDetail: { id: "task-a", name: "Task A", description: "TASK_DESC_V2" },
    }),
    messages,
  );
});

it("keeps the old description until confirmation and leaves it intact on cancel", async () => {
  await draftUpdate();
  expect(await nextContext()).toContain("TASK_DESC_V1");
  expect(task.description).toBe("TASK_DESC_V1");
  expect((await cancelPendingTaskAction(input)).cancelled).toBe(true);
  expect((await confirmPendingTaskAction(input)).noPending).toBe(true);
  expect(await nextContext()).toContain("TASK_DESC_V1");
});

it("keeps the old description and pending action on update failure, allowing a retry", async () => {
  await draftUpdate();
  vi.spyOn(client, "updateTask").mockRejectedValueOnce(new Error("kernel unavailable"));
  expect((await confirmPendingTaskAction(input)).success).toBe(false);
  expect(await nextContext()).toContain("TASK_DESC_V1");
  expect((await confirmPendingTaskAction(input)).success).toBe(true);
  expect(await nextContext()).toContain("TASK_DESC_V2");
});

it("fills a missing task snapshot from the successful update response", async () => {
  const store = getSessionStore();
  await store.set("claude-code:session-a", { ...store.get("claude-code:session-a")!, taskDetail: null });
  await draftUpdate();
  expect((await confirmPendingTaskAction(input)).success).toBe(true);
  expect(await nextContext()).toContain("TASK_DESC_V2");
});

it("uses the server response, including clearing a description returned as null", async () => {
  await draftUpdate();
  vi.spyOn(client, "updateTask").mockResolvedValueOnce({ ...task, description: null });
  expect((await confirmPendingTaskAction(input)).success).toBe(true);
  const context = await nextContext();
  expect(context).toContain("Task A");
  expect(context).not.toContain("TASK_DESC_V1");
  expect(context).not.toContain("TASK_DESC_V2");
});

it("preserves changes to unrelated session fields made while the update is in flight", async () => {
  await draftUpdate();
  const store = getSessionStore();
  const update = client.updateTask.bind(client);
  vi.spyOn(client, "updateTask").mockImplementationOnce(async (id, patch) => {
    await store.set("claude-code:session-a", {
      ...store.get("claude-code:session-a")!, agentDetail: { id: "agent-a", name: "New agent name" },
    });
    return update(id, patch);
  });
  expect((await confirmPendingTaskAction(input)).success).toBe(true);
  const context = await nextContext();
  expect(context).toContain("New agent name");
  expect(context).toContain("TASK_DESC_V2");
});

it("does not overwrite a different task bound while the update is in flight", async () => {
  await draftUpdate();
  const store = getSessionStore();
  const update = client.updateTask.bind(client);
  vi.spyOn(client, "updateTask").mockImplementationOnce(async (id, patch) => {
    const state = store.get("claude-code:session-a")!;
    await store.set("claude-code:session-a", {
      ...state, sessionInfo: { ...state.sessionInfo!, task_id: "task-b" },
      taskDetail: { id: "task-b", name: "Task B", description: "TASK_B_DESC" },
    });
    return update(id, patch);
  });
  expect((await confirmPendingTaskAction(input)).success).toBe(true);
  const context = await nextContext();
  expect(context).toContain("TASK_B_DESC");
  expect(context).not.toContain("TASK_DESC_V2");
});

it("persists the updated snapshot so a fresh SessionStore injects it after L2a recovery", async () => {
  let saved: SessionInitState | null = null;
  const repo: SessionRepo = {
    upsert: vi.fn(async (_space, _user, _source, _session, state) => { saved = structuredClone(state); }),
    getBySessionId: vi.fn(async () => structuredClone(saved)),
    deleteBySessionId: vi.fn(),
    loadAllInitialized: vi.fn(async () => []),
  };
  const seed = getSessionStore().get("claude-code:session-a")!;
  __resetSessionStoreForTests();
  vi.mocked(getSessionRepo).mockReturnValue(repo);
  const identity = { userId: "user-a", agentSource: "claude-code", sessionId: "session-a", spaceId: "space-a" };
  const store = getSessionStore();
  store.bind("claude-code:session-a", identity);
  await store.set("claude-code:session-a", seed);
  await draftUpdate();
  expect((await confirmPendingTaskAction(input)).success).toBe(true);

  const recoveredStore = new SessionStore(undefined, repo);
  await recoveredStore.getOrRecover("claude-code:session-a", identity, {});
  const context = await nextContext(recoveredStore);
  expect(context).toContain("TASK_DESC_V2");
  expect(context).not.toContain("TASK_DESC_V1");
});
