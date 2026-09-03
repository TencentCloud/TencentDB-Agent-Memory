import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { TdaiClient } from "../tdai/client.js";
import { withL0Retry } from "../tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "../tdai/types.js";

/**
 * Gate del fix #1089: los fallos del write L0 (/v3/conversation/add) NO se
 * tragan más. Antes, postForCtx devolvía {} en HTTP≠2xx / envelope code≠0 /
 * red rota → withL0Retry nunca entraba al catch → 1 intento, fallo invisible
 * ("write skipped" indistinguible de "write attempted and failed").
 *
 * Comportamiento esperado (repro del issue):
 *   - fetch mock 503 → withL0Retry(() => addConversation) hace 3 llamadas
 *   - agotados los reintentos → rechaza con error estructurado (TdaiWriteError)
 *   - envelope code≠0 (HTTP 200) → también lanza (el kernel rechazó el write)
 *   - 4xx (no reintentable) → 1 sola llamada, rechaza directo
 *   - paths de lectura (searchL1 etc.) conservan la semántica silenciosa {}
 *     (la inyección degrada, no rompe) — guard de regresión.
 */

const identity: TdaiIdentity = {
  teamId: "team-x",
  userId: "usr-x",
  agentId: "agt-x",
  sessionId: "sess-x",
  taskId: "task-x",
};

const msgs: TdaiMessage[] = [{ role: "user", content: "hola" }];

function makeClient(): TdaiClient {
  return new TdaiClient({
    enabled: true,
    endpoint: "http://kernel.test",
    apiKey: "k",
    serviceId: "default",
    writeL0: true,
    timeoutMs: 1000,
  } as never);
}

const origFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.useRealTimers();
});

describe("#1089 addConversation no traga fallos", () => {
  it("HTTP 503 → 3 intentos con withL0Retry, luego rechaza con TdaiWriteError", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response("boom", { status: 503 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const p = withL0Retry(() => client.addConversation(identity, msgs), { attempts: 3, baseMs: 1 });
    const assertion = expect(p).rejects.toMatchObject({ name: "TdaiWriteError", status: 503 });

    // con fake timers, drenar los backoffs (1ms base → esperas cortas)
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(3);
  });

  it("HTTP 200 con envelope code!=0 → rechaza (kernel rechazó el write)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify({ code: 40101, message: "session not initialized" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const p = withL0Retry(() => client.addConversation(identity, msgs), { attempts: 3, baseMs: 1 });
    // "HTTP 200" en el message → isRetryable: 200 no es >=500 ni 408/429 → 1 intento.
    const assertion = expect(p).rejects.toMatchObject({ name: "TdaiWriteError" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(1);
  });

  it("HTTP 400 (no reintentable) → 1 sola llamada, rechaza directo", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;

    const client = makeClient();
    const p = withL0Retry(() => client.addConversation(identity, msgs), { attempts: 3, baseMs: 1 });
    const assertion = expect(p).rejects.toMatchObject({ name: "TdaiWriteError", status: 400 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(1);
  });

  it("éxito HTTP 200 code=0 → resuelve normal (sin cambio de happy path)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, message: "ok", data: { accepted_ids: ["m1"] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const client = makeClient();
    await expect(client.addConversation(identity, msgs)).resolves.toBeUndefined();
  });
});

describe("regresion: rutas de lectura siguen degradando silenciosamente", () => {
  it("searchL1 con kernel caído → [] (inyección no rompe)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const client = makeClient();
    await expect(client.searchL1(identity, "q")).resolves.toEqual([]);
  });
});
