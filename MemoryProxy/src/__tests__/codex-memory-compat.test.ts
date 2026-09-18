import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { injectCodexAssets } from "../codexHandler.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";
import { getSessionStore } from "../session/store.js";
import type { ProxyConfig } from "../types.js";
import type { SessionInitState } from "../session/types.js";

// Keep the real store behavior without opening the user's default SQLite DB.
vi.mock("../session/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session/store.js")>();
  const store = new actual.SessionStore();
  return { ...actual, getSessionStore: () => store };
});

const marker = "codex-memory-regression";
const tools = { type: "additional_tools", role: "developer", tools: [] };
const developer = { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] };
const user = { type: "message", role: "user", content: [{ type: "input_text", text: "question" }] };

describe("Codex memory injection", () => {
  it.each([
    ["legacy developer message", [developer, user], 0],
    ["additional_tools prefix", [tools, developer, user], 1],
    ["implicit message with string content", [tools, { role: "developer", content: "instructions" }, user], 1],
    ["system message", [tools, { ...developer, role: "system" }, user], 1],
  ])("injects into %s without mutating input", (_name, input, index) => {
    const body = { input };
    const original = JSON.stringify(body);
    const output = injectCodexAssets(body, { raw: marker });
    const messages = output.input as Array<Record<string, unknown>>;
    expect(JSON.stringify(messages[index as number].content)).toContain(marker);
    expect(JSON.stringify(messages[index as number].content)).toContain("instructions");
    expect(JSON.stringify(body)).toBe(original);
    expect(messages.at(-1)).toEqual(user);
    if (index === 1) expect(messages[0]).toEqual(tools);
  });

  it("adds an instruction message without changing tool declarations or the user message", () => {
    const body = { input: [tools, user] };
    const output = injectCodexAssets(body, { raw: marker });
    const messages = output.input as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual(tools);
    expect(messages[1]).toMatchObject({ type: "message", role: "developer" });
    expect(JSON.stringify(messages[1].content)).toContain(marker);
    expect(messages[2]).toEqual(user);
    expect(body.input).toEqual([tools, user]);
  });
});

describe("Codex memory bridge identity", () => {
  it("resolves a bare Codex session ID and preserves trusted scope and cross-session search", async () => {
    const sid = "codex-memory-bridge-regression";
    await getSessionStore().set(`codex:${sid}`, {
      status: "initialized", keyId: sid, userId: "test-user", startedAt: Date.now(), attemptCount: 0,
      sessionInfo: { user_id: "test-user", team_id: "test-team", agent_id: "test-agent", session_id: sid, space_id: "default" },
    } satisfies SessionInitState);
    let outbound: Record<string, unknown> | undefined;
    const handler = createMemoryBridgeHandler({
      coreSkill: { endpoint: "http://memory.test", serviceToken: "test-token", serviceId: "default", timeoutMs: 1000 },
    } as ProxyConfig, {
      fetcher: async (_url, init) => {
        outbound = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ code: 0, data: { messages: [{ id: "m1", content: marker, score: 1 }] } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
    });
    const app = new Hono();
    app.post("/memory-bridge/*", handler);
    const response = await app.request("/memory-bridge/v3/conversation/search", {
      method: "POST", headers: { "Content-Type": "application/json", "x-conversation-id": sid },
      body: JSON.stringify({ query: marker, user_id: "forged", team_id: "forged", agent_id: "forged" }),
    });
    expect(response.status).toBe(200);
    expect(outbound).toMatchObject({ user_id: "test-user", team_id: "test-team", agent_id: "test-agent" });
    expect(outbound).not.toHaveProperty("session_id");
    expect((await response.json()).data.messages[0].content).toBe(marker);
    const unknown = await app.request("/memory-bridge/v3/conversation/search", {
      method: "POST", headers: { "Content-Type": "application/json", "x-conversation-id": "unknown" },
      body: JSON.stringify({ query: marker }),
    });
    expect(unknown.status).toBe(401);
  });
});
