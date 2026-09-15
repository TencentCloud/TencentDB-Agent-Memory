import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../../../types.js";
import {
  __resetSessionStoreForTests,
  getSessionStore,
} from "../../../session/store.js";
import type { SessionBinding } from "../../../db/binding-repo.js";
import {
  __resetInitLinkStoreForTests,
  createOrReusePendingToken,
  validateInitLinkToken,
} from "../../../session/init-link.js";
import {
  CoreSkillClient,
  setCoreSkillClient,
} from "../../../skill/core-client.js";
import { resetSessionBinding } from "../session-reset.js";

const config = {
  coreSkill: {
    endpoint: "http://kernel.test",
    serviceToken: "svc-token",
    serviceId: "mem-space1",
    timeoutMs: 1000,
  },
} as unknown as ProxyConfig;

describe("resetSessionBinding", () => {
  const bindings = new Map<string, SessionBinding>();
  const requestedUrls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(
      JSON.stringify({ code: 0, data: { status: "archived" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  beforeEach(() => {
    __resetSessionStoreForTests();
    __resetInitLinkStoreForTests();
    bindings.clear();
    requestedUrls.length = 0;
    setCoreSkillClient(new CoreSkillClient(config.coreSkill, fetcher));
    getSessionStore().setBindingRepo({
      getBinding: async (spaceId, sessionId) =>
        bindings.get(`${spaceId}:${sessionId}`) ?? null,
      putBinding: async (spaceId, sessionId, binding) => {
        bindings.set(`${spaceId}:${sessionId}`, binding);
      },
      deleteBinding: async (spaceId, sessionId) => {
        bindings.delete(`${spaceId}:${sessionId}`);
      },
      touchLastSeen: async () => {},
    });
  });

  it("archives, clears binding, resets state, and invalidates old links", async () => {
    const store = getSessionStore();
    const compositeKey = "hermes:sess-reset";
    store.bind(compositeKey, {
      userId: "usr-1",
      agentSource: "hermes",
      sessionId: "sess-reset",
      spaceId: "mem-space1",
    });
    await store.set(compositeKey, {
      status: "initialized",
      keyId: "sess-reset",
      startedAt: Date.now(),
      attemptCount: 0,
      userId: "usr-1",
      sessionInfo: {
        session_id: "sess-reset",
        user_id: "usr-1",
        team_id: "team-1",
        agent_id: "agt-1",
        task_id: "task-1",
        space_id: "mem-space1",
      },
    });
    const { record } = createOrReusePendingToken({
      compositeKey,
      sessionId: "sess-reset",
      agentSource: "hermes",
      userId: "usr-1",
      userKey: "user-key",
      spaceId: "mem-space1",
      purpose: "init",
    });

    const result = await resetSessionBinding({
      sessionKey: "sess-reset",
      agentSource: "hermes",
      config,
      spaceId: "mem-space1",
      userId: "usr-1",
    });

    expect(result.oldStatus).toBe("initialized");
    expect(store.get(compositeKey)).toMatchObject({
      status: "uninitialized",
      resetFlow: true,
      userId: "usr-1",
    });
    expect(bindings.has("mem-space1:sess-reset")).toBe(false);
    expect(validateInitLinkToken(record.token)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain(
      "/v3/skill/conversation/force-archive",
    );
  });
});
