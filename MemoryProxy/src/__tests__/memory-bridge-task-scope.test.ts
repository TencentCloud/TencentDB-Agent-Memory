import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Gate del fix de scope de búsqueda (fix/search-task-scope):
 *   1. search sin task_id explícito → NO inyecta task_id de sesión (scope agente).
 *   2. search con task_id="no-task" explícito → respeta el filtro explícito.
 *   3. search con task_id="default" explícito → respeta el filtro explícito.
 *   4. operaciones no-search (atomic/query) → siguen heredando task_id de sesión.
 *   5. user_id/team_id/agent_id → siempre reescritos por el Proxy (identidad
 *      no falsificable), con o sin task_id.
 *
 * Estrategia: mockear fetch del handler (deps.fetcher) e inspeccionar el body
 * outbound hacia Core. El session store se carga con una sesión ligada a
 * task_id="default" — igual que la sesión real que motivó el incidente.
 */

import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";
import type { ProxyConfig } from "../types.js";

const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];

const fetcherMock = vi.fn(async (url: string, init: RequestInit) => {
  fetchCalls.push({ url, body: JSON.parse(String(init.body)) });
  return new Response(
    JSON.stringify({ code: 0, message: "ok", data: { items: [], messages: [] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

async function setupHandler() {
  __resetSessionStoreForTests?.();
  const store: any = getSessionStore();
  store.states.set("sess-test-1", {
    status: "initialized",
    keyId: "sess-test-1",
    startedAt: Date.now(),
    attemptCount: 1,
    sessionInfo: {
      session_id: "sess-test-1",
      team_id: "team-session",
      agent_id: "agt-session",
      user_id: "usr-session",
      task_id: "default",
    },
  });

  const config = {
    coreSkill: { endpoint: "http://core.test", serviceToken: "t", serviceId: "svc", timeoutMs: 1000 },
    bridgeTelemetry: { enabled: false },
  } as unknown as ProxyConfig;

  return createMemoryBridgeHandler(config, { fetcher: fetcherMock as any });
}

function makeCtx(path: string, body: Record<string, unknown>): any {
  const req = new Request(`http://p.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-conversation-id": "sess-test-1",
      "x-tdai-service-id": "svc",
    },
    body: JSON.stringify(body),
  });
  return {
    req: {
      url: req.url,
      method: req.method,
      header: (n: string) => req.headers.get(n) ?? "",
      text: () => req.text(),
    },
  };
}

describe("memory-bridge task scope (fix/search-task-scope)", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
  });

  it("1. atomic/search sin task_id → outbound SIN task_id (scope agente)", async () => {
    const handler = await setupHandler();
    const res = await handler(makeCtx("/memory-bridge/v3/atomic/search", { query: "J(π)", limit: 5 }));
    expect(res.status).toBe(200);
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect("task_id" in fetchCalls[0].body).toBe(false);
  });

  it("2. atomic/search con task_id='no-task' explícito → conservado", async () => {
    const handler = await setupHandler();
    await handler(makeCtx("/memory-bridge/v3/atomic/search", { query: "J(π)", limit: 5, task_id: "no-task" }));
    expect(fetchCalls[0].body.task_id).toBe("no-task");
  });

  it("3. conversation/search con task_id='default' explícito → conservado", async () => {
    const handler = await setupHandler();
    await handler(makeCtx("/memory-bridge/v3/conversation/search", { query: "test", limit: 5, task_id: "default" }));
    expect(fetchCalls[0].body.task_id).toBe("default");
  });

  it("4. atomic/query (no-search) sin task_id → hereda task_id de sesión", async () => {
    const handler = await setupHandler();
    await handler(makeCtx("/memory-bridge/v3/atomic/query", { type: "episodic", limit: 5 }));
    expect(fetchCalls[0].body.task_id).toBe("default");
  });

  it("5. identidad: user/team/agent siempre reescritos aunque el body intente falsificarlos", async () => {
    const handler = await setupHandler();
    await handler(makeCtx("/memory-bridge/v3/atomic/search", {
      query: "test",
      user_id: "usr-falso",
      team_id: "team-falsa",
      agent_id: "agt-falso",
    }));
    const out = fetchCalls[0].body;
    expect(out.user_id).toBe("usr-session");
    expect(out.team_id).toBe("team-session");
    expect(out.agent_id).toBe("agt-session");
  });
});
