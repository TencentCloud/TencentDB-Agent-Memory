import { afterEach, describe, expect, it, vi } from "vitest";

import { initAuth, verifyUserKey } from "../auth.js";
import { MetadataClient, resolveMemoryUserId } from "../meta/client.js";
import { handleSessionInit } from "../session/claude-code/init.js";
import { SessionStore } from "../session/store.js";
import {
  _resetSystemUsersForTest,
  initSystemUsers,
  matchSystemUserByUserId,
} from "../systemUser.js";
import { deriveTdaiIdentity } from "../tdai/identity.js";
import { recordTdaiTurn } from "../tdai/recorder.js";
import type { TdaiClient } from "../tdai/client.js";

const callerKey = "sk-mem-caller";
const sessionKey = "session-test";

function metadataClient(resolveUserId = "usr-test"): MetadataClient {
  return {
    resolveCallerUserId: vi.fn().mockResolvedValue(resolveUserId),
    getAgent: vi.fn().mockResolvedValue({
      agent_id: "agent-test",
      team_id: "team-test",
      name: "Test agent",
    }),
  } as unknown as MetadataClient;
}

async function runMemoryFlow(memoryUserId: string, client: MetadataClient) {
  const store = new SessionStore();
  const compositeKey = `claude-code:${sessionKey}`;
  store.bind(compositeKey, {
    userId: memoryUserId,
    agentSource: "claude-code",
    sessionId: sessionKey,
    spaceId: "space-test",
  });

  const result = await handleSessionInit(
    sessionKey,
    memoryUserId,
    [{ role: "user", content: "remember this" }],
    {
      enabled: true,
      maxRetries: 3,
      debugForceIdentity: {
        team_id: "team-test",
        agent_id: "agent-test",
      },
    },
    store,
    { stream: false, modelId: "test", protocol: "anthropic" },
    client,
    callerKey,
    "space-test",
  );
  const identity = deriveTdaiIdentity({
    sessionInfo: result.sessionInfo as unknown as Record<string, unknown> | null | undefined,
    userId: memoryUserId,
    sessionKey,
    userKey: callerKey,
  });
  const addConversation = vi.fn();

  await recordTdaiTurn(
    { addConversation } as unknown as TdaiClient,
    identity,
    { role: "user", content: "remember this" },
    "acknowledged",
  );

  return { addConversation, identity, result, store, compositeKey };
}

describe("auth-disabled memory identity", () => {
  afterEach(() => {
    initAuth({ enabled: false, url: "", timeoutMs: 5_000 });
    _resetSystemUsersForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the proxy-verified user without an additional metadata lookup", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { valid: true, user: { user_id: "usr-test" } },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    initAuth({ enabled: true, url: "http://auth.test", timeoutMs: 5_000 });
    const auth = await verifyUserKey(callerKey, "space-test");
    const client = metadataClient();
    const memoryUserId = await resolveMemoryUserId({
      verifiedUserId: auth.userId,
      callerUserKey: callerKey,
      metadataClient: client,
    });

    expect(auth).toEqual({ userId: "usr-test", rejected: false });
    expect(memoryUserId).toBe("usr-test");
    expect(client.resolveCallerUserId).not.toHaveBeenCalled();

    const flow = await runMemoryFlow(memoryUserId!, client);
    expect(flow.result.bypassed).not.toBe(true);
    expect(flow.result.sessionInfo?.user_id).toBe("usr-test");
    expect(flow.store.getBoundIdentity(flow.compositeKey)?.userId).toBe("usr-test");
    expect(flow.identity?.userId).toBe("usr-test");
    expect(flow.addConversation).toHaveBeenCalledOnce();
  });

  it("resolves a separate memory identity when proxy auth is disabled", async () => {
    initAuth({ enabled: false, url: "", timeoutMs: 5_000 });
    const auth = await verifyUserKey(callerKey, "space-test");
    const client = metadataClient();
    const memoryUserId = await resolveMemoryUserId({
      verifiedUserId: auth.userId,
      callerUserKey: callerKey,
      metadataClient: client,
    });

    expect(auth).toEqual({ userId: "", rejected: false });
    expect(memoryUserId).toBe("usr-test");
    expect(client.resolveCallerUserId).toHaveBeenCalledOnce();

    const flow = await runMemoryFlow(memoryUserId!, client);
    expect(flow.result.bypassed).not.toBe(true);
    expect(flow.result.sessionInfo?.user_id).toBe("usr-test");
    expect(flow.store.getBoundIdentity(flow.compositeKey)?.userId).toBe("usr-test");
    expect(flow.store.getBoundIdentity(flow.compositeKey)?.userId).not.toBe("anonymous");
    expect(flow.identity?.userId).toBe("usr-test");
    expect(flow.addConversation).toHaveBeenCalledOnce();
  });

  it("sends the caller key through the authenticated metadata path", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { user_id: "usr-test", username: "test" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new MetadataClient({
      endpoint: "http://memory-core.test",
      serviceToken: "service-token",
      timeoutMs: 5_000,
    }, "space-test", callerKey, fetcher);

    await expect(resolveMemoryUserId({
      verifiedUserId: null,
      callerUserKey: callerKey,
      metadataClient: client,
    })).resolves.toBe("usr-test");

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://memory-core.test/v3/meta/user/get");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer service-token",
      "x-tdai-service-id": "space-test",
      "x-tdai-user-key": callerKey,
    });
    expect(JSON.parse(String(request.body))).toEqual({ user_key: callerKey });
  });

  it("does not reuse a resolved identity for another caller key", async () => {
    const firstClient = metadataClient("usr-first");
    const secondClient = metadataClient("usr-second");

    await expect(resolveMemoryUserId({
      verifiedUserId: null,
      callerUserKey: "sk-mem-first",
      metadataClient: firstClient,
    })).resolves.toBe("usr-first");
    await expect(resolveMemoryUserId({
      verifiedUserId: null,
      callerUserKey: "sk-mem-second",
      metadataClient: secondClient,
    })).resolves.toBe("usr-second");

    expect(firstClient.resolveCallerUserId).toHaveBeenCalledOnce();
    expect(secondClient.resolveCallerUserId).toHaveBeenCalledOnce();
  });

  it("does not invent an identity when auth is disabled without a caller key", async () => {
    initAuth({ enabled: false, url: "", timeoutMs: 5_000 });
    const auth = await verifyUserKey("", "space-test");
    const client = metadataClient();
    const memoryUserId = await resolveMemoryUserId({
      verifiedUserId: auth.userId,
      callerUserKey: null,
      metadataClient: client,
    });

    expect(auth.rejected).toBe(false);
    expect(memoryUserId).toBeNull();
    expect(client.resolveCallerUserId).not.toHaveBeenCalled();
    const identity = deriveTdaiIdentity({ userId: memoryUserId, sessionKey });
    const addConversation = vi.fn();
    await recordTdaiTurn(
      { addConversation } as unknown as TdaiClient,
      identity,
      { role: "user", content: "remember this" },
      "acknowledged",
    );
    expect(identity).toBeNull();
    expect(addConversation).not.toHaveBeenCalled();
  });

  it("keeps forwarding allowed when caller identity resolution fails", async () => {
    initAuth({ enabled: false, url: "", timeoutMs: 5_000 });
    const auth = await verifyUserKey("invalid-key", "space-test");
    const client = metadataClient();
    vi.mocked(client.resolveCallerUserId).mockRejectedValueOnce(new Error("unauthorized"));
    const memoryUserId = await resolveMemoryUserId({
      verifiedUserId: auth.userId,
      callerUserKey: "invalid-key",
      metadataClient: client,
    });

    expect(auth.rejected).toBe(false);
    expect(memoryUserId).toBeNull();
    const identity = deriveTdaiIdentity({ userId: memoryUserId, sessionKey });
    const addConversation = vi.fn();
    await recordTdaiTurn(
      { addConversation } as unknown as TdaiClient,
      identity,
      { role: "user", content: "remember this" },
      "acknowledged",
    );
    expect(identity).toBeNull();
    expect(addConversation).not.toHaveBeenCalled();
  });

  it("does not log caller credentials when metadata resolution fails", async () => {
    const secret = "SUPER_SECRET_CALLER_KEY";
    const fetcher = vi.fn().mockResolvedValue(new Response(
      `Authorization: Bearer ${secret}`,
      { status: 401 },
    ));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new MetadataClient({
      endpoint: "http://memory-core.test",
      serviceToken: "service-token",
      timeoutMs: 5_000,
    }, "space-test", secret, fetcher);

    await expect(resolveMemoryUserId({
      verifiedUserId: null,
      callerUserKey: secret,
      metadataClient: client,
    })).resolves.toBeNull();

    const serializedLogs = JSON.stringify([
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(secret);
    expect(serializedLogs).not.toContain(`Bearer ${secret}`);
  });

  it("preserves auth-enabled rejection without trying the fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { valid: false },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    initAuth({ enabled: true, url: "http://auth.test", timeoutMs: 5_000 });

    await expect(verifyUserKey("invalid-key", "space-test")).resolves.toEqual({
      userId: "",
      rejected: true,
      rejectReason: "invalid user_key",
    });
  });

  it("does not use the resolved memory identity for system-user matching", async () => {
    initSystemUsers([{
      name: "memory",
      userId: "usr-system",
      displayName: "Memory service",
    }]);
    initAuth({ enabled: false, url: "", timeoutMs: 5_000 });
    const auth = await verifyUserKey(callerKey, "space-test");
    const client = metadataClient("usr-system");
    const memoryUserId = await resolveMemoryUserId({
      verifiedUserId: auth.userId,
      callerUserKey: callerKey,
      metadataClient: client,
    });

    expect(memoryUserId).toBe("usr-system");
    expect(matchSystemUserByUserId(auth.userId)).toBeNull();
    expect(matchSystemUserByUserId(memoryUserId!)).not.toBeNull();
  });
});
