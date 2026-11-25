import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DEFAULT_CONFIG } from "../../config.js";
import { initAuth } from "../../auth.js";
import { handleChatCompletions } from "../../handler.js";
import { __resetSessionStoreForTests, getSessionStore } from "../store.js";
import { setMetadataClient } from "../../meta/client.js";

// Keep the handler's real session state machine, but avoid the user's local DB.
vi.mock("../../db/sessionRepo.js", () => ({ getSessionRepo: () => undefined }));
vi.mock("../../credit-reporter.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../credit-reporter.js")>(),
  tryReportCreditFromPath: vi.fn(async () => ({ attempted: false, ok: false })),
}));
vi.mock("../../instance-upstream-cache.js", () => ({
  getInstanceUpstreamConfigs: vi.fn(async () => []),
  resolveUpstreamConfig: vi.fn(() => undefined),
  shouldOverride: vi.fn(() => false),
}));

describe("taskless CodeBuddy request flow", () => {
  beforeEach(() => {
    __resetSessionStoreForTests();
    setMetadataClient(null);
    initAuth({ enabled: true, url: "http://core.test", timeoutMs: 5000 });
  });

  afterEach(() => {
    initAuth({ enabled: false, url: "", timeoutMs: 5000 });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetSessionStoreForTests();
    setMetadataClient(null);
  });

  it("registers zero-task team assets and sends L0 writes for forwarded turns", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.upstream.url = "http://llm.test";
    config.rateLimit = { tpm: 0, qpm: 0 };
    config.sessionInit.enabled = true;
    config.sessionInit.defaultTaskId = undefined;
    config.coreSkill.endpoint = "http://core.test";
    config.tdai.enabled = true;
    config.tdai.endpoint = "http://core.test";
    config.tdai.memory.enabled = true;
    config.tdai.memory.writeL0 = true;
    config.extraction.extractors = ["tdai-memory"];

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const unexpected: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url, body });
      if (url.endsWith("/v3/meta/auth/verify")) {
        return Response.json({ code: 0, data: { valid: true, user: { user_id: "usr-test" } } });
      }
      if (url.endsWith("/v3/meta/team/list")) {
        return Response.json({ code: 0, data: { items: [{ team_id: "team-test", name: "Test team" }], total: 1 } });
      }
      if (url.endsWith("/v3/meta/agent/list")) {
        return Response.json({ code: 0, data: { items: [{ agent_id: "agent-test", name: "Test agent" }], total: 1 } });
      }
      if (url.endsWith("/v3/meta/task/list")) return Response.json({ code: 0, data: { items: [], total: 0 } });
      if (url.endsWith("/v3/meta/agent/get")) {
        return Response.json({ code: 0, data: { agent_id: "agent-test", name: "Test agent", description: "Agent context" } });
      }
      if (url.endsWith("/v3/meta/config/user/get")) return Response.json({ code: 0, data: { items: [] } });
      if (url.endsWith("/v3/conversation/add")) return Response.json({ code: 0, data: {} });
      if (url.startsWith("http://llm.test")) {
        return Response.json({ id: "reply-test", object: "chat.completion", model: "test", choices: [{ index: 0, message: { role: "assistant", content: "Acknowledged" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      }
      unexpected.push(url);
      throw new Error(`Unexpected request: ${url}`);
    }));

    const app = new Hono();
    app.post("/codebuddy/:space/v1/chat/completions", (c) => handleChatCompletions(c, config));
    const send = (message: string) => app.request("/codebuddy/space-test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-test", "x-conversation-id": "session-taskless-handler" },
      body: JSON.stringify({ model: "test", stream: false, messages: [{ role: "user", content: message }] }),
    });

    const form = await send("Remember my preference");
    expect(form.status).toBe(200);
    expect(getSessionStore().get("codebuddy:session-taskless-handler")?.status).toBe("pending_asset_confirm");
    expect(calls.some((call) => call.url.startsWith("http://llm.test"))).toBe(false);

    const response = await send("是，关联团队资产");
    expect(response.status).toBe(200);
    const state = getSessionStore().get("codebuddy:session-taskless-handler");
    expect(state?.bypassed).not.toBe(true);
    expect(state?.sessionInfo).toMatchObject({ team_id: "team-test", agent_id: "agent-test", user_id: "usr-test", session_id: "session-taskless-handler" });
    expect(state?.sessionInfo?.task_id).toBeUndefined();
    const writes = calls.filter((call) => call.url.endsWith("/v3/conversation/add"));
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({
      team_id: "team-test", agent_id: "agent-test", user_id: "usr-test", session_id: "session-taskless-handler",
      messages: [{ role: "user", content: "是，关联团队资产" }, { role: "assistant", content: "Acknowledged" }],
    });
    expect(writes[0].body).not.toHaveProperty("task_id");

    const next = await send("Remember that I prefer tea");
    expect(next.status).toBe(200);
    const allWrites = calls.filter((call) => call.url.endsWith("/v3/conversation/add"));
    expect(allWrites).toHaveLength(2);
    expect(allWrites[1].body).toMatchObject({
      team_id: "team-test", agent_id: "agent-test", user_id: "usr-test", session_id: "session-taskless-handler",
      messages: [{ role: "user", content: "Remember that I prefer tea" }, { role: "assistant", content: "Acknowledged" }],
    });
    expect(allWrites[1].body).not.toHaveProperty("task_id");
    expect(unexpected).toEqual([]);
  });
});
