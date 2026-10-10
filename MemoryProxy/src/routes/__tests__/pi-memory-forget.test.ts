import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgetPendingStore, type ForgetTarget } from "../../memory/forget-pending-store.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import { createPiMemoryForgetHandlers } from "../pi-memory-forget.js";
import { initAuth } from "../../auth.js";

const identity = { userId: "user-a", teamId: "team-a", agentId: "agent-a", serviceId: "space-a" };
const target: ForgetTarget = {
  kind: "skill",
  id: "skill-a",
  name: "deploy-check",
  teamId: "team-a",
  agentId: "agent-a",
  preview: "token [REDACTED]",
  detail: "version 3",
};

function setup() {
  const service = {
    discover: vi.fn(async () => [target]),
    execute: vi.fn(async () => undefined),
  };
  const handlers = createPiMemoryForgetHandlers({} as any, {
    service,
    pending: new ForgetPendingStore({ createId: () => "action-a" }),
    resolveSession: () => ({ sessionKey: "pi:session-a", identity }),
  });
  const app = new Hono();
  app.post("/preview", handlers.preview);
  app.post("/confirm", handlers.confirm);
  return { app, service };
}

async function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  __resetSessionStoreForTests();
  initAuth({ enabled: false, url: "", timeoutMs: 0 });
  vi.unstubAllGlobals();
});

describe("Pi memory forget routes", () => {
  it("prepares selectable actions without deleting during discovery", async () => {
    const { app, service } = setup();
    const discovery = await post(app, "/preview", { keyword: "deploy" });
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      code: 0,
      data: { state: "select", candidates: [{ actionId: "action-a", preview: "token [REDACTED]" }] },
    });
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("rejects an unknown action id", async () => {
    const { app, service } = setup();
    await post(app, "/preview", { keyword: "deploy" });

    const response = await post(app, "/confirm", { action_id: "attacker-choice" });

    expect(response.status).toBe(404);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("double confirm executes one delete and replays the result", async () => {
    const { app, service } = setup();
    await post(app, "/preview", { keyword: "deploy" });

    const first = await post(app, "/confirm", { action_id: "action-a" });
    const second = await post(app, "/confirm", { action_id: "action-a" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(service.execute).toHaveBeenCalledOnce();
    expect(service.execute).toHaveBeenCalledWith(identity, target);
  });
});

describe("Pi memory forget route identity", () => {
  async function setupAuthenticatedRoute() {
    await getSessionStore().set("pi:pi-session-a", {
      status: "initialized",
      keyId: "pi:pi-session-a",
      startedAt: Date.now(),
      attemptCount: 0,
      sessionInfo: {
        session_id: "pi-session-a",
        user_id: "user-a",
        user_key: "user-key-a",
        team_id: "team-a",
        agent_id: "agent-a",
        space_id: "space-a",
      },
    });
    const service = {
      discover: vi.fn(async () => [target]),
      execute: vi.fn(async () => undefined),
    };
    const handlers = createPiMemoryForgetHandlers({ coreSkill: { serviceId: "fallback" } } as any, { service });
    const app = new Hono();
    app.post("/preview", handlers.preview);
    app.post("/confirm", handlers.confirm);
    return { app, service };
  }

  function enableLiveAuth() {
    initAuth({ enabled: true, url: "https://auth.fixture", timeoutMs: 1000 });
    const fetcher = vi.fn(async () => Response.json({
      code: 0, data: { valid: true, user: { user_id: "user-a" } },
    }));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  it("verifies the key and session user again on both preview and confirm", async () => {
    const fetcher = enableLiveAuth();
    const { app, service } = await setupAuthenticatedRoute();
    const preview = await app.request("/preview", authenticatedRequest("user-key-a", { keyword: "deploy" }));
    expect(preview.status).toBe(200);
    const actionId = (await preview.json()).data.candidates[0].actionId;
    const confirm = await app.request("/confirm", authenticatedRequest("user-key-a", { action_id: actionId }));
    expect(confirm.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith("https://auth.fixture/v3/meta/auth/verify", expect.objectContaining({
      body: JSON.stringify({ user_key: "user-key-a" }),
      headers: { "content-type": "application/json", "x-tdai-service-id": "space-a" },
    }));
    expect(service.execute).toHaveBeenCalledWith(identity, target);
  });

  it.each(["revoked", "different-user", "unavailable", "malformed"])(
    "rejects preview and a previously prepared confirm when live auth is %s",
    async (failure) => {
      const fetcher = enableLiveAuth();
      const { app, service } = await setupAuthenticatedRoute();
      const preview = await app.request("/preview", authenticatedRequest("user-key-a", { keyword: "deploy" }));
      expect(preview.status).toBe(200);
      const actionId = (await preview.json()).data.candidates[0].actionId;
      service.discover.mockClear();

      if (failure === "unavailable") fetcher.mockRejectedValue(new Error("auth is down"));
      else fetcher.mockImplementation(async () => Response.json(failure === "revoked"
        ? { code: 0, data: { valid: false } }
        : failure === "different-user"
          ? { code: 0, data: { valid: true, user: { user_id: "other-user" } } }
          : { code: 0, data: { valid: true } }));

      const rejectedPreview = await app.request("/preview", authenticatedRequest("user-key-a", { keyword: "deploy" }));
      const rejectedConfirm = await app.request("/confirm", authenticatedRequest("user-key-a", { action_id: actionId }));
      expect(rejectedPreview.status).toBe(401);
      expect(rejectedConfirm.status).toBe(401);
      expect(service.discover).not.toHaveBeenCalled();
      expect(service.execute).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  function authenticatedRequest(userKey: string, body: unknown) {
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${userKey}`,
        "x-conversation-id": "pi-session-a",
        "x-tdai-service-id": "space-a",
      },
      body: JSON.stringify(body),
    };
  }

  it("rejects a bearer key that does not own the initialized session", async () => {
    const { app, service } = await setupAuthenticatedRoute();

    const response = await app.request("/preview", authenticatedRequest("wrong-key", { keyword: "deploy" }));

    expect(response.status).toBe(401);
    expect(service.discover).not.toHaveBeenCalled();
  });

  it("derives identity from the session instead of request body fields", async () => {
    const { app, service } = await setupAuthenticatedRoute();

    const response = await app.request("/preview", authenticatedRequest("user-key-a", {
      keyword: "deploy",
      team_id: "attacker-team",
      agent_id: "attacker-agent",
    }));

    expect(response.status).toBe(200);
    expect(service.discover).toHaveBeenCalledWith(identity, "deploy");
  });
});
