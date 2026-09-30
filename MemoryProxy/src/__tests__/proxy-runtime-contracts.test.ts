import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { completeRegistration } from "../session/codebuddy/init.js";
import { SessionStore } from "../session/store.js";
import type { SessionInitState, TeamOption } from "../session/types.js";
import { tryReportCreditFromPath } from "../credit-reporter.js";
import { opencodeAdapter } from "../agent-adapters/opencode.js";
import { buildRequestDebugMetadata } from "../common/langfuse-debug.js";
import { __resetProxyStorageForTests, getEffectiveBackend, initProxyStorage } from "../storage/factory.js";

afterEach(() => {
  vi.restoreAllMocks();
  __resetProxyStorageForTests();
});

describe("session-reset registration result", () => {
  const teams: TeamOption[] = [{ team_id: "team", team_name: "Team", agents: [{ agent_id: "agent", agent_name: "Agent" }], tasks: [] }];

  it("retains resetFlow when registration completes", async () => {
    const store = new SessionStore();
    const state: SessionInitState = { status: "pending_agent_task", keyId: "codebuddy:reset", startedAt: Date.now(), attemptCount: 0, userId: "user", resetFlow: true };
    const result = await completeRegistration({ agent_id: "agent", task_id: "task" }, state, teams,
      "codebuddy:reset", "reset", "user", DEFAULT_CONFIG.sessionInit, store, []);
    expect(result).toMatchObject({ resetFlow: true, justRegistered: true, sessionInfo: { team_id: "team", agent_id: "agent", user_id: "user", session_id: "reset" } });
    expect(store.get("codebuddy:reset")).toMatchObject({ status: "initialized", resetFlow: true });
  });

  it("retains resetFlow when registration must bypass", async () => {
    const state: SessionInitState = { status: "pending_agent_task", keyId: "codebuddy:reset", startedAt: Date.now(), attemptCount: 0, resetFlow: true };
    const result = await completeRegistration({ agent_id: "agent" }, state, teams,
      "codebuddy:reset", "reset", null, DEFAULT_CONFIG.sessionInit, new SessionStore(), []);
    expect(result).toMatchObject({ resetFlow: true, bypassed: true, justRegistered: true });
  });
});

describe("credit report outcomes", () => {
  const report = { url: "http://billing.test/report", timeoutMs: 1000 };
  const path = "/proxy/space/v1/messages";
  const usage = { input_tokens: 10, output_tokens: 2 };

  it("preserves a successful report result", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"code":0}', { status: 200 }));
    expect(await tryReportCreditFromPath(report, path, usage, undefined)).toMatchObject({ attempted: true, ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains error details from a failed report", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }));
    expect(await tryReportCreditFromPath(report, path, usage, undefined)).toMatchObject({ attempted: true, ok: false, errorMessage: expect.stringContaining("HTTP 503") });
  });

  it("skips missing usage and analyzer-only usage without a network call", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    expect(await tryReportCreditFromPath(report, path, {}, undefined)).toEqual({ attempted: false, ok: false });
    expect(await tryReportCreditFromPath(report, path, usage, undefined, undefined, undefined, "analyzer_usage")).toEqual({ attempted: false, ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("optional COS extension", () => {
  it("starts the local memory backend without the extension", async () => {
    const config = structuredClone(DEFAULT_CONFIG.storage);
    config.backend = "memory";
    const storage = await initProxyStorage(config);
    await storage.putJSON("fixture.json", { value: 1 });
    expect(await storage.getJSON("fixture.json")).toEqual({ value: 1 });
    expect(getEffectiveBackend()).toMatchObject({ requested: "memory", effective: "memory" });
  });

  it("fails explicitly when COS is requested without its extension", async () => {
    const config = structuredClone(DEFAULT_CONFIG.storage);
    config.backend = "cos";
    await expect(initProxyStorage(config)).rejects.toThrow("cos backend init failed (no fallback)");
    expect(getEffectiveBackend().error).toContain("cost-guard submodule not loaded");
  });
});

it("keeps auxiliary title generation distinct from a main OpenCode turn", () => {
  expect(opencodeAdapter.classifyRequest({ messages: [{ role: "system", content: "You are a title generator. You output ONLY a thread title." }] })).toBe("auxiliary");
  expect(opencodeAdapter.classifyRequest({ messages: [{ role: "user", content: "actual user turn" }] })).toBe("main");
});

it("retains an auxiliary request category in tracing metadata", () => {
  expect(buildRequestDebugMetadata({ debug: true, body: {}, headers: {},
    agentSource: "opencode", requestKind: "auxiliary", protocol: "anthropic" }))
    .toMatchObject({ request_kind: "auxiliary" });
});
