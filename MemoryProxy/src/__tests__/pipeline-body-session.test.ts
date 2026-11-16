import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { runOpenaiChatPipeline } from "../pipeline/runners/openai-chat.js";
import { runAnthropicPipeline } from "../pipeline/runners/anthropic.js";

// Isolate external identity/config services. Body parsing and both runners are real.
vi.mock("../auth.js", () => ({ verifyUserKey: async () => ({ userId: "synthetic-user", rejected: false }) }));
vi.mock("../wecom-identity-form.js", () => ({ requireWecomIdentity: async () => ({ kind: "resolved", name: "test" }) }));
vi.mock("../pipeline/stages/instance-upstream-early.js", () => ({
  stageInstanceUpstreamEarly: async () => ({ legacyProxy: false, isCustomUpstream: false }),
}));
// Observe the actual routing key handed to session processing, then stop before
// persistence, model calls or telemetry. Missing body wiring produces a fallback key.
vi.mock("../pipeline/stages/session-reset-pre-hook.js", () => ({
  stageSessionResetPreHook: async ({ sessionKey }: { sessionKey: string }) => Response.json({ sessionKey }),
}));

describe.each([
  ["OpenAI", "/hermes/test-space/v1/chat/completions", runOpenaiChatPipeline],
  ["Anthropic", "/hermes/test-space/v1/messages", runAnthropicPipeline],
] as const)("%s body session routing", (_protocol, path, run) => {
  async function request(sessionId: string, headers: Record<string, string> = {}) {
    const app = new Hono();
    app.post(path, (c) => run(c, { ...DEFAULT_CONFIG, sessionInit: { ...DEFAULT_CONFIG.sessionInit!, enabled: true } }));
    const response = await app.request(path, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hello" }], metadata: { session_id: sessionId } }),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  it("passes each topic's ID to session processing", async () => {
    expect(await request("topic-a")).toEqual({ sessionKey: "topic-a" });
    expect(await request("topic-b")).toEqual({ sessionKey: "topic-b" });
  });

  it("keeps header and parent-session precedence", async () => {
    expect(await request("body", { "x-conversation-id": "header" })).toEqual({ sessionKey: "header" });
    expect(await request("body", { "x-conversation-id": "child", "x-parent-conversation-id": "parent" })).toEqual({ sessionKey: "parent" });
  });
});
