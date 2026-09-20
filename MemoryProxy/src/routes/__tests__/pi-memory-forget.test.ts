import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForgetPendingStore, type ForgetTarget } from "../../memory/forget-pending-store.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import { createPiMemoryForgetHandlers } from "../pi-memory-forget.js";

const identity = { userId: "user-a", teamId: "team-a", agentId: "agent-a", serviceId: "space-a" };
const target: ForgetTarget = {
  key: "candidate-a",
  kind: "skill",
  id: "skill-a",
  name: "deploy-check",
  teamId: "team-a",
  agentId: "agent-a",
  preview: "token [REDACTED]",
  detail: "version 3",
  impact: "Deletes every version.",
};

function setup() {
  const service = {
    discover: vi.fn(async () => [target]),
    execute: vi.fn(async () => ({ kind: target.kind, name: target.name })),
  };
  const handlers = createPiMemoryForgetHandlers({} as any, {
    service,
    pending: new ForgetPendingStore({ createId: () => "action-a" }),
    resolveSession: () => ({ sessionKey: "pi:session-a", identity }),
  });
  const app = new Hono();
  app.post("/preview", handlers.preview);
  app.post("/confirm", handlers.confirm);
  app.post("/cancel", handlers.cancel);
  return { app, service };
}

async function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => __resetSessionStoreForTests());

describe("Pi memory forget routes", () => {
  it("does not delete during discovery or selection preparation", async () => {
    const { app, service } = setup();
    const discovery = await post(app, "/preview", { keyword: "deploy" });
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      code: 0,
      data: { state: "select", candidates: [{ key: "candidate-a", preview: "token [REDACTED]" }] },
    });
    const prepared = await post(app, "/preview", { keyword: "deploy", candidate_key: "candidate-a" });
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({ code: 0, data: { state: "pending", actionId: "action-a" } });
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("redacts candidate names in preview and confirmation responses", async () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const unsafeTarget = { ...target, name: `deploy ${secret}` };
    const service = {
      discover: vi.fn(async () => [unsafeTarget]),
      execute: vi.fn(async () => ({ kind: unsafeTarget.kind, name: unsafeTarget.name })),
    };
    const handlers = createPiMemoryForgetHandlers({} as any, {
      service,
      pending: new ForgetPendingStore({ createId: () => "action-a" }),
      resolveSession: () => ({ sessionKey: "pi:session-a", identity }),
    });
    const app = new Hono();
    app.post("/preview", handlers.preview);
    app.post("/confirm", handlers.confirm);

    const discovery = await post(app, "/preview", { keyword: "deploy" });
    const discoveryJson = await discovery.json() as any;
    expect(discoveryJson.data.candidates[0].name).toBe("deploy [REDACTED]");

    await post(app, "/preview", { keyword: "deploy", candidate_key: unsafeTarget.key });
    const confirmation = await post(app, "/confirm", { action_id: "action-a" });
    const confirmationJson = await confirmation.json() as any;
    expect(confirmationJson.data.candidate.name).toBe("deploy [REDACTED]");
    expect(JSON.stringify(confirmationJson)).not.toContain(secret);
  });

  it("rejects candidate substitution", async () => {
    const { app, service } = setup();
    await post(app, "/preview", { keyword: "deploy" });

    const response = await post(app, "/preview", { keyword: "deploy", candidate_key: "attacker-choice" });

    expect(response.status).toBe(404);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("cancel leaves the target untouched", async () => {
    const { app, service } = setup();
    await post(app, "/preview", { keyword: "deploy" });
    await post(app, "/preview", { keyword: "deploy", candidate_key: "candidate-a" });

    const cancel = await post(app, "/cancel", { action_id: "action-a" });
    const confirm = await post(app, "/confirm", { action_id: "action-a" });

    expect(cancel.status).toBe(200);
    expect(confirm.status).toBe(409);
    expect(service.execute).not.toHaveBeenCalled();
  });

  it("double confirm executes one delete and replays the result", async () => {
    const { app, service } = setup();
    await post(app, "/preview", { keyword: "deploy" });
    await post(app, "/preview", { keyword: "deploy", candidate_key: "candidate-a" });

    const first = await post(app, "/confirm", { action_id: "action-a" });
    const second = await post(app, "/confirm", { action_id: "action-a" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ code: 0, data: { alreadyCompleted: true } });
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
      discover: vi.fn(async () => []),
      execute: vi.fn(async () => ({ kind: target.kind, name: target.name })),
    };
    const handlers = createPiMemoryForgetHandlers({ coreSkill: { serviceId: "fallback" } } as any, { service });
    const app = new Hono();
    app.post("/preview", handlers.preview);
    return { app, service };
  }

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
