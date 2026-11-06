import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DEFAULT_CONFIG } from "../config.js";
import { initAuth } from "../auth.js";
import { __resetSessionStoreForTests, getSessionStore } from "../session/store.js";
import { handleAnthropicMessages } from "../anthropicHandler.js";
import { InjectionPipeline } from "../injection/pipeline.js";
import { HookRegistryImpl } from "../injection/registry.js";
import { AnthropicAdapter } from "../injection/adapters/anthropic.js";
import { TdaiMemoryToolsInjector } from "../injection/injectors/tdai-tools-injector.js";
import type { AgentContextMetadata } from "../injection/types.js";

const injection = vi.hoisted(() => ({
  process: vi.fn(async (body: Record<string, unknown>, _metadata: AgentContextMetadata) => body),
  prewarm: vi.fn(async () => ({ cachedHookIds: [], skipped: [], durationMs: 0 })),
}));
vi.mock("../db/sessionRepo.js", () => ({ getSessionRepo: () => undefined }));
vi.mock("../credit-reporter.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../credit-reporter.js")>(),
  tryReportCreditFromPath: vi.fn(async () => ({ attempted: false, ok: false })),
}));

vi.mock("../injection/index.js", () => ({
  getInjectionPipeline: () => ({ process: injection.process }),
  prewarmFromConfig: injection.prewarm,
}));
vi.mock("../instance-upstream-cache.js", () => ({
  getInstanceUpstreamConfigs: vi.fn(async () => []),
  resolveUpstreamConfig: vi.fn(() => undefined),
  shouldOverride: vi.fn(() => false),
}));

describe("auth-disabled Anthropic handler memory flow", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    initAuth({ enabled: false, url: "", timeoutMs: 5000 });
    injection.process.mockClear();
    const registry = new HookRegistryImpl();
    registry.register(new TdaiMemoryToolsInjector({ proxyBaseUrl: "https://proxy.test" }));
    const pipeline = new InjectionPipeline(registry, new Map([["anthropic", new AnthropicAdapter()]]));
    injection.process.mockImplementation((body, metadata) => pipeline.process(body, metadata));
    injection.prewarm.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetSessionStoreForTests();
  });

  it.each([
    { valid: true, key: "sk-mem-valid" },
    { valid: false, key: "sk-mem-invalid" },
  ])("forwards with valid=$valid and uses memory only when identity resolves", async ({ valid, key }) => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "http://llm.test";
    config.ccRequestRouting.enabled = false;
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.creditReport.url = "";
    config.coreSkill.endpoint = "http://core.test";
    config.sessionInit.enabled = true;
    config.sessionInit.debugForceIdentity = { team_id: "team-test", agent_id: "agent-test" };
    config.injection.enabled = true;
    config.injection.injectors = ["tdai-memory"];
    config.tdai.enabled = true;
    config.tdai.endpoint = "http://core.test";
    config.tdai.memory.enabled = true;
    config.tdai.memory.writeL0 = true;
    config.extraction.extractors = ["tdai-memory"];

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url, body });
      if (url.endsWith("/v3/meta/user/get")) {
        return valid ? Response.json({ code: 0, data: { user_id: "usr-test" } }) : new Response("invalid", { status: 401 });
      }
      if (url.endsWith("/v3/meta/agent/get")) {
        return Response.json({ code: 0, data: { agent_id: "agent-test", name: "Test agent", description: "agent context" } });
      }
      if (url.endsWith("/v3/meta/config/user/get")) return Response.json({ code: 0, data: { items: [] } });
      if (url.endsWith("/v3/conversation/add")) return Response.json({ code: 0, data: {} });
      if (url.startsWith("http://llm.test")) {
        return Response.json({ id: "msg-test", type: "message", role: "assistant", content: [{ type: "text", text: "acknowledged" }], model: "test", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      }
      throw new Error(`Unexpected request to ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const app = new Hono();
    app.post("/claude-code/:space/v1/messages", (c) => handleAnthropicMessages(c, config));
    const response = await app.request("/claude-code/space-test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-conversation-id": `session-${valid}` },
      body: JSON.stringify({ model: "test", max_tokens: 64, messages: [{ role: "user", content: "remember this" }] }),
    });

    expect(response.status).toBe(200);
    expect(requests.find((r) => r.url.endsWith("/v3/meta/user/get"))?.body).toEqual({ user_key: key });
    const forwarded = requests.find((r) => r.url.startsWith("http://llm.test"));
    expect(forwarded).toBeDefined();
    if (valid) {
      expect(injection.process).toHaveBeenCalledOnce();
      expect(injection.process.mock.calls[0][1]).toMatchObject({ userId: "usr-test" });
      expect(JSON.stringify(forwarded?.body.system)).toContain("<tdai_memory_tools>");
      expect(getSessionStore().getBoundIdentity("claude-code:session-true")?.userId).toBe("usr-test");
      await vi.waitFor(() => expect(requests.some((r) => r.url.endsWith("/v3/conversation/add"))).toBe(true));
      expect(requests.find((r) => r.url.endsWith("/v3/conversation/add"))?.body).toMatchObject({ user_id: "usr-test", team_id: "team-test", agent_id: "agent-test", session_id: "session-true" });
    } else {
      expect(injection.process).not.toHaveBeenCalled();
      expect(getSessionStore().getBoundIdentity("claude-code:session-false")).toBeUndefined();
      expect(requests.some((r) => r.url.endsWith("/v3/conversation/add"))).toBe(false);
    }
  });
});
