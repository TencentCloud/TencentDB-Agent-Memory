/**
 * Session-init web-link endpoint tests.
 *
 * Covers the token lifecycle (init/rebind/one-shot/TTL) and the two HTTP
 * endpoints with a stubbed metadata layer — no kernel, no real HTTP.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ProxyConfig } from "../../types.js";
import { registerSessionInitLinkRoutes } from "../session-init-link.js";
import {
  __resetInitLinkStoreForTests,
  buildInitLinkUrl,
  consumeInitLinkToken,
  createInitLinkToken,
} from "../../session/init-link.js";
import { __resetSessionStoreForTests, getSessionStore } from "../../session/store.js";
import type { TeamOption } from "../../session/types.js";
import type { SessionBinding } from "../../db/binding-repo.js";

const TEAMS: TeamOption[] = [
  {
    team_id: "team-1",
    team_name: "trial-team",
    agents: [
      { agent_id: "agt-1", agent_name: "hermes-assistant", description: "d" },
      { agent_id: "agt-2", agent_name: "other-agent" },
    ],
    tasks: [{ task_id: "task-1", task_name: "session-init 全链路验证" }],
  },
];
const BINDINGS = new Map<string, SessionBinding>();

function installBindingRepo(): void {
  getSessionStore().setBindingRepo({
    getBinding: async (spaceId, sessionId) =>
      BINDINGS.get(`${spaceId}:${sessionId}`) ?? null,
    putBinding: async (spaceId, sessionId, binding) => {
      BINDINGS.set(`${spaceId}:${sessionId}`, binding);
    },
    deleteBinding: async (spaceId, sessionId) => {
      BINDINGS.delete(`${spaceId}:${sessionId}`);
    },
    touchLastSeen: async () => {},
  });
}

function makeConfig(): ProxyConfig {
  // Minimal slice — registerSessionInitLinkRoutes only touches coreSkill and
  // sessionInit; completeRegistration touches sessionInit + store + client.
  return {
    coreSkill: {
      endpoint: "http://kernel.test",
      serviceToken: "svc-token",
      serviceId: "default",
      timeoutMs: 1000,
    },
    sessionInit: {
      enabled: true,
      maxRetries: 3,
      defaultTaskId: "default",
    },
  } as unknown as ProxyConfig;
}

function makeApp() {
  const app = new Hono();
  registerSessionInitLinkRoutes(app, makeConfig(), {
    fetchTeams: async () => ({ teams: TEAMS }),
    createClient: () =>
      ({
        getAgent: async () => ({
          agent_id: "agt-1",
          name: "hermes-assistant",
          description: "d",
          prompt: "p",
        }),
        getTask: async () => ({ task_id: "task-1", title: "session-init 全链路验证" }),
        appendParticipationLog: async () => ({}),
      }) as never,
  });
  return app;
}

function mintToken(overrides?: Partial<Parameters<typeof createInitLinkToken>[0]>) {
  return createInitLinkToken({
    compositeKey: "dsh:sess-1",
    sessionId: "sess-1",
    agentSource: "dsh",
    userId: "usr-1",
    userKey: "sk-user",
    spaceId: "mem-space1",
    purpose: "init",
    ttlMinutes: 10,
    ...overrides,
  });
}

async function jsonReq(app: Hono, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("session-init web link endpoints", () => {
  beforeEach(() => {
    __resetInitLinkStoreForTests();
    __resetSessionStoreForTests();
    BINDINGS.clear();
    installBindingRepo();
    vi.restoreAllMocks();
  });

  // ── GET ────────────────────────────────────────────────────────────────
  it("GET with a valid token returns candidates and metadata", async () => {
    const { token } = mintToken();
    const res = await jsonReq(makeApp(), "GET", `/v3/session/init-link/${token}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.purpose).toBe("init");
    expect(data.agent_source).toBe("dsh");
    expect(data.session_id).toBe("sess-1");
    const teams = data.teams as TeamOption[];
    expect(teams[0].team_id).toBe("team-1");
    expect(teams[0].agents).toHaveLength(2);
    expect(teams[0].tasks).toHaveLength(1);
  });

  it("GET with unknown token → 404 not_found", async () => {
    const res = await jsonReq(makeApp(), "GET", "/v3/session/init-link/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).reason).toBe("not_found");
  });

  it("GET with expired token → 404 expired", async () => {
    const { token } = mintToken({ ttlMinutes: 0.00001 });
    await new Promise((r) => setTimeout(r, 10));
    const res = await jsonReq(makeApp(), "GET", `/v3/session/init-link/${token}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).reason).toBe("expired");
  });

  it("GET never consumes the token (repeat GET stays 200)", async () => {
    const { token } = mintToken();
    expect((await jsonReq(makeApp(), "GET", `/v3/session/init-link/${token}`)).status).toBe(200);
    expect((await jsonReq(makeApp(), "GET", `/v3/session/init-link/${token}`)).status).toBe(200);
  });

  it("GET after consumption → 404 consumed", async () => {
    const { token } = mintToken();
    consumeInitLinkToken(token);
    const res = await jsonReq(makeApp(), "GET", `/v3/session/init-link/${token}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Record<string, unknown>).reason).toBe("consumed");
  });

  // ── POST ───────────────────────────────────────────────────────────────
  it("POST valid choice registers the binding and consumes the token", async () => {
    const { token, compositeKey } = mintToken();
    const res = await jsonReq(makeApp(), "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-1",
      task_id: "task-1",
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.team_id).toBe("team-1");
    expect(data.agent_id).toBe("agt-1");
    expect(data.task_id).toBe("task-1");

    const state = getSessionStore().get(compositeKey);
    expect(state?.status).toBe("initialized");
    expect(state?.sessionInfo?.team_id).toBe("team-1");
    expect(state?.sessionInfo?.agent_id).toBe("agt-1");
    expect(state?.sessionInfo?.task_id).toBe("task-1");
    expect(state?.sessionInfo?.user_id).toBe("usr-1");
    expect(state?.sessionInfo?.session_id).toBe("sess-1");
    expect(getSessionStore().getBoundIdentity(compositeKey)).toEqual({
      userId: "usr-1",
      agentSource: "dsh",
      sessionId: "sess-1",
      spaceId: "mem-space1",
    });
    expect(BINDINGS.get("mem-space1:sess-1")).toMatchObject({
      outcome: "initialized",
      userId: "usr-1",
      agentId: "agt-1",
      taskId: "task-1",
      agentSource: "dsh",
    });

    __resetSessionStoreForTests();
    installBindingRepo();
    const recovered = await getSessionStore().getOrRecover(
      compositeKey,
      {
        userId: "usr-1",
        agentSource: "dsh",
        sessionId: "sess-1",
        spaceId: "mem-space1",
      },
      {},
    );
    expect(recovered?.status).toBe("initialized");
    expect(recovered?.sessionInfo?.agent_id).toBe("agt-1");
  });

  it("POST without agent_id → 400", async () => {
    const { token } = mintToken();
    const res = await jsonReq(makeApp(), "POST", `/v3/session/init-link/${token}`, {});
    expect(res.status).toBe(400);
  });

  it("POST with malformed JSON → 400", async () => {
    const { token } = mintToken();
    const res = makeApp().request(`/v3/session/init-link/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await res).status).toBe(400);
  });

  it("POST with an agent outside the caller's teams → 403 and token survives", async () => {
    const { token } = mintToken();
    const res = await jsonReq(makeApp(), "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-foreign",
    });
    expect(res.status).toBe(403);
    // Token must not be burned by a rejected submit.
    expect((await jsonReq(makeApp(), "GET", `/v3/session/init-link/${token}`)).status).toBe(200);
  });

  it("POST with a task outside the selected team → 403", async () => {
    const { token } = mintToken();
    const res = await jsonReq(makeApp(), "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-1",
      task_id: "task-foreign",
    });
    expect(res.status).toBe(403);
  });

  it("POST is one-shot: second submit → 404 consumed", async () => {
    const { token } = mintToken();
    const first = await jsonReq(makeApp(), "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-1",
    });
    expect(first.status).toBe(200);
    const second = await jsonReq(makeApp(), "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-2",
    });
    expect(second.status).toBe(404);
    expect(((await second.json()) as Record<string, unknown>).reason).toBe("consumed");
  });

  it("allows only one concurrent POST to claim the token", async () => {
    const { token } = mintToken();
    const app = makeApp();
    const responses = await Promise.all([
      jsonReq(app, "POST", `/v3/session/init-link/${token}`, {
        agent_id: "agt-1",
      }),
      jsonReq(app, "POST", `/v3/session/init-link/${token}`, {
        agent_id: "agt-2",
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200,
      409,
    ]);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict).toBeDefined();
    expect(((await conflict!.json()) as Record<string, unknown>).reason).toBe("processing");
  });

  it("POST when candidate load fails → 502 and the token is NOT consumed", async () => {
    const app = new Hono();
    registerSessionInitLinkRoutes(app, makeConfig(), {
      fetchTeams: async () => {
        throw new Error("kernel down");
      },
    });
    const { token } = mintToken();
    const res = await jsonReq(app, "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-1",
    });
    expect(res.status).toBe(502);
    // A transient failure must not burn the user's one shot: still 502 on
    // retry (kernel still down), never a consumed-404.
    const retry = await jsonReq(app, "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-1",
    });
    expect(retry.status).toBe(502);
    expect(((await retry.json()) as Record<string, unknown>).error).toBe("candidate_load_failed");
  });

  it("POST when durable binding verification fails → 502 and remains retryable", async () => {
    getSessionStore().setBindingRepo({
      getBinding: async () => null,
      putBinding: async () => {},
      deleteBinding: async () => {},
      touchLastSeen: async () => {},
    });
    const { token } = mintToken();
    const app = makeApp();
    const res = await jsonReq(app, "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-1",
    });
    expect(res.status).toBe(502);
    expect((await jsonReq(app, "GET", `/v3/session/init-link/${token}`)).status).toBe(200);
  });

  it("POST without task_id (agent-only) registers with no task", async () => {
    const { token, compositeKey } = mintToken();
    const res = await jsonReq(makeApp(), "POST", `/v3/session/init-link/${token}`, {
      agent_id: "agt-1",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).task_id).toBeNull();
    const state = getSessionStore().get(compositeKey);
    expect(state?.sessionInfo?.task_id).toBeUndefined();
  });
});

describe("init-link url & token store", () => {
  beforeEach(() => __resetInitLinkStoreForTests());

  it("buildInitLinkUrl encodes proxy origin and token into the Hub hash route", () => {
    const url = buildInitLinkUrl("http://hub:8125/", "http://proxy:8096", "tok/en+1");
    expect(url).toBe("http://hub:8125/#/session-init?proxy=http%3A%2F%2Fproxy%3A8096&token=tok%2Fen%2B1");
  });

  it("token store caps pending entries (oldest evicted)", async () => {
    for (let i = 0; i < 120; i++) {
      mintToken({ compositeKey: `dsh:s${i}` });
    }
    // Oldest tokens evicted beyond the 100 cap.
    const size = (await import("../../session/init-link.js")).__initLinkStoreSizeForTests();
    expect(size).toBeLessThanOrEqual(100);
  });
});
