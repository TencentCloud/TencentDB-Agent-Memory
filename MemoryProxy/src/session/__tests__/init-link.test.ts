import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { ProxyConfig } from "../../types.js";
import type { MetadataClient } from "../../meta/client.js";
import { registerSessionInitLinkRoutes } from "../../routes/session-init-link.js";
import { SessionStore } from "../store.js";
import type { TeamOption } from "../types.js";
import {
  createOrReusePendingToken,
  validateInitLinkToken,
  claimInitLinkToken,
  completeInitLinkToken,
  releaseInitLinkToken,
  invalidateInitLinkTokensForSession,
  buildInitLinkUrl,
  buildInitLinkNotice,
  __resetInitLinkStoreForTests,
  __initLinkStoreSizeForTests,
  DEFAULT_TTL_MINUTES,
} from "../init-link.js";

const baseParams = {
  compositeKey: "hermes:ses_123",
  sessionId: "ses_123",
  agentSource: "hermes",
  userId: "u1",
  userKey: "sk-test",
  spaceId: "sp1",
  purpose: "init" as const,
};

describe("init-link token store", () => {
  beforeEach(() => {
    __resetInitLinkStoreForTests();
  });

  it("creates a pending token", () => {
    const { record, created } = createOrReusePendingToken(baseParams);
    expect(created).toBe(true);
    expect(record.status).toBe("pending");
    expect(record.token).toHaveLength(32);
    expect(record.expiresAt).toBeGreaterThan(record.createdAt);
  });

  it("rejects non-finite token lifetimes", () => {
    const { record } = createOrReusePendingToken({ ...baseParams, ttlMinutes: Number.POSITIVE_INFINITY });
    expect(record.expiresAt - record.createdAt).toBe(DEFAULT_TTL_MINUTES * 60_000);
  });

  it("reuses existing pending token for same identity", () => {
    const first = createOrReusePendingToken(baseParams);
    const second = createOrReusePendingToken(baseParams);
    expect(second.created).toBe(false);
    expect(second.record.token).toBe(first.record.token);
  });

  it("validates a pending token", () => {
    const { record } = createOrReusePendingToken(baseParams);
    const v = validateInitLinkToken(record.token);
    expect(v.ok).toBe(true);
  });

  it("rejects unknown token", () => {
    const v = validateInitLinkToken("nonexistent");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("not_found");
  });

  it("claim → complete lifecycle", () => {
    const { record } = createOrReusePendingToken(baseParams);
    const claim = claimInitLinkToken(record.token);
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.record.status).toBe("processing");
      expect(claim.claimId).toBeDefined();
      const completed = completeInitLinkToken(record.token, claim.claimId);
      expect(completed.ok).toBe(true);
      if (completed.ok) expect(completed.record.status).toBe("consumed");
    }
  });

  it("complete with wrong claimId fails", () => {
    const { record } = createOrReusePendingToken(baseParams);
    claimInitLinkToken(record.token);
    const result = completeInitLinkToken(record.token, "wrong-claim");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("claim_mismatch");
  });

  it("release returns token to pending", () => {
    const { record } = createOrReusePendingToken(baseParams);
    const claim = claimInitLinkToken(record.token);
    if (!claim.ok) throw new Error("claim failed");
    const released = releaseInitLinkToken(record.token, claim.claimId);
    expect(released.ok).toBe(true);
    if (released.ok) expect(released.record.status).toBe("pending");
  });

  it("consumed token rejects further validation", () => {
    const { record } = createOrReusePendingToken(baseParams);
    const claim = claimInitLinkToken(record.token);
    if (claim.ok) completeInitLinkToken(record.token, claim.claimId);
    const v = validateInitLinkToken(record.token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("consumed");
  });

  it("invalidateInitLinkTokensForSession removes by compositeKey", () => {
    createOrReusePendingToken(baseParams);
    expect(__initLinkStoreSizeForTests()).toBe(1);
    const removed = invalidateInitLinkTokensForSession(baseParams.compositeKey);
    expect(removed).toBe(1);
    expect(__initLinkStoreSizeForTests()).toBe(0);
  });
});

describe("init-link URL and notice", () => {
  it("buildInitLinkUrl encodes proxy and token", () => {
    const url = buildInitLinkUrl("http://hub:8125", "http://proxy:8096", "abc123");
    expect(url).toContain("http://hub:8125/#/session-init");
    expect(url).toContain("proxy=http%3A%2F%2Fproxy%3A8096");
    expect(url).toContain("token=abc123");
  });

  it("buildInitLinkNotice init purpose", () => {
    const url = "http://hub:8125/#/session-init?token=abc";
    const notice = buildInitLinkNotice(url, "init", 10);
    expect(notice).toContain("TencentDB Agent Memory");
    expect(notice).toContain(url);
    expect(notice).toContain("10");
  });

  it("buildInitLinkNotice rebind purpose", () => {
    const url = "http://hub:8125/#/session-init?token=abc";
    const notice = buildInitLinkNotice(url, "rebind", 10);
    expect(notice).toContain("mem:session-reset");
    expect(notice).toContain(url);
  });
});

const routeTeams: TeamOption[] = [{
  team_id: "team-1",
  team_name: "Team One",
  agents: [{ agent_id: "agent-1", agent_name: "Agent One" }],
  tasks: [{ task_id: "task-1", task_name: "Task One" }],
}];

function createRouteApp(store: SessionStore): Hono {
  const app = new Hono();
  const config = {
    sessionInit: {
      enabled: true,
      maxRetries: 3,
      injectAgentContext: true,
      injectTaskContext: true,
    },
    coreSkill: { serviceId: "sp1" },
  } as unknown as ProxyConfig;
  const client = {
    getAgent: async (agentId: string) => ({ agent_id: agentId, name: "Agent One" }),
    getTask: async (taskId: string) => ({ task_id: taskId, title: "Task One" }),
  } as unknown as MetadataClient;
  registerSessionInitLinkRoutes(app, config, {
    store,
    fetchTeams: async () => ({ teams: routeTeams }),
    createClient: () => client,
  });
  return app;
}

describe("init-link routes", () => {
  beforeEach(() => {
    __resetInitLinkStoreForTests();
  });

  it("loads candidates without consuming the token", async () => {
    const app = createRouteApp(new SessionStore());
    const { record } = createOrReusePendingToken(baseParams);
    const response = await app.request(`/v3/session/init-link/${record.token}`);
    expect(response.status).toBe(200);
    expect((await response.json()).teams).toEqual(routeTeams);
    expect(validateInitLinkToken(record.token).ok).toBe(true);
  });

  it("registers an owned selection and invalidates session tokens", async () => {
    const store = new SessionStore();
    const app = createRouteApp(store);
    const { record } = createOrReusePendingToken(baseParams);
    createOrReusePendingToken({ ...baseParams, purpose: "rebind" });
    const response = await app.request(`/v3/session/init-link/${record.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-1", task_id: "task-1" }),
    });
    expect(response.status).toBe(200);
    expect(store.get(baseParams.compositeKey)?.sessionInfo?.agent_id).toBe("agent-1");
    expect(__initLinkStoreSizeForTests()).toBe(0);
  });

  it("rejects an agent outside the caller's teams without consuming the token", async () => {
    const app = createRouteApp(new SessionStore());
    const { record } = createOrReusePendingToken(baseParams);
    const response = await app.request(`/v3/session/init-link/${record.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "other-agent" }),
    });
    expect(response.status).toBe(403);
    expect(validateInitLinkToken(record.token).ok).toBe(true);
  });
});
