import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DEFAULT_CONFIG } from "../../config.js";
import { handleChatCompletions } from "../../handler.js";
import { handleAnthropicMessages } from "../../anthropicHandler.js";
import { handleCodexEndpoint } from "../../codexHandler.js";
import { handleWorkbuddyEndpoint } from "../../workbuddyHandler.js";
import { clearCache as clearInstanceUpstreamCache } from "../../instance-upstream-cache.js";
import type { ProxyConfig } from "../../types.js";

afterEach(() => {
  clearInstanceUpstreamCache();
  vi.unstubAllGlobals();
});
const isInstanceUpstreamRequest = (url: string) => url.endsWith("/v3/internal/meta/instance-upstream/list");
function config(protocol: "chat" | "anthropic" | "responses"): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream = { url: "https://upstream.invalid/v1", apiKey: "fixture-server-key", protocol, maxTokens: 1024, agents: {} };
  config.extraction.enabled = false;
  config.creditPricing.models = [{ name: "m", modelName: "m", input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 }];
  return config;
}
const anth = { id: "msg_a", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
const chat = { id: "chat_a", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
const responses = { id: "resp_a", object: "response", status: "completed", model: "m", output: [{ type: "message", id: "item_a", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [] }], status: "completed" }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } } };
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const anthropicStream = event("message_start", { type: "message_start", message: { id: "msg_a", model: "m", content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
  + event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
  + event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })
  + event("content_block_stop", { type: "content_block_stop", index: 0 })
  + event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })
  + event("message_stop", { type: "message_stop" });
const chatStream = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;

describe("actual inference handlers cross the configured protocol boundary", () => {
  it("Messages handler sends Responses upstream and returns a Messages response", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(String(url)); return Response.json(responses); }));
    const app = new Hono(); app.post("/v1/messages", c => handleAnthropicMessages(c, config("responses")));
    const response = await app.request("/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "fixture" }, body: JSON.stringify({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["https://upstream.invalid/v1/responses"]);
    expect(await response.json()).toMatchObject({ type: "message", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }] });
  });

  it("Chat handler converts an upstream Messages SSE through the real stream path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(anthropicStream, { headers: { "content-type": "text/event-stream" } })));
    const app = new Hono(); app.post("/v1/chat/completions", c => handleChatCompletions(c, config("anthropic")));
    const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }], stream: true }) });
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"content":"hello"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  it("Messages handler converts an upstream Chat SSE through the real stream path", async () => {
    const stream = chatStream({ id: "chat_a", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] })
      + chatStream({ id: "chat_a", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + "data: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })));
    const app = new Hono(); app.post("/v1/messages", c => handleAnthropicMessages(c, config("chat")));
    const response = await app.request("/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "fixture" }, body: JSON.stringify({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "hello" }], stream: true }) });
    const text = await response.text();
    expect(text).toContain('"text":"hello"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain('"type":"message_stop"');
  });
  it.each([
    ["codex", handleCodexEndpoint],
    ["workbuddy", handleWorkbuddyEndpoint],
  ] as const)("%s Responses handler sends Messages upstream and returns Responses JSON", async (agent, handler) => {
    const settings = config("anthropic");
    settings.upstream.agents[agent] = { url: "https://upstream.invalid/v1", protocol: "anthropic", maxTokens: 2048 };
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (isInstanceUpstreamRequest(String(url))) return Response.json({ code: 0, data: { items: [] } });
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Response.json(anth);
    }));
    const app = new Hono(); app.post(`/${agent}/fixture/v1/responses`, c => handler(c, settings));
    const response = await app.request(`/${agent}/fixture/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify({ model: "m", input: "hello", max_output_tokens: 100, stream: false }) });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://upstream.invalid/v1/messages");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
    expect(await response.json()).toMatchObject({ object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }] });
  });

  it("Codex Responses handler converts an upstream Messages SSE through the real stream path", async () => {
    const settings = config("anthropic");
    settings.upstream.agents.codex = { url: "https://upstream.invalid/v1", protocol: "anthropic", maxTokens: 2048 };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => isInstanceUpstreamRequest(String(url))
      ? Response.json({ code: 0, data: { items: [] } })
      : new Response(anthropicStream, { headers: { "content-type": "text/event-stream" } })));
    const app = new Hono(); app.post("/codex/fixture/v1/responses", c => handleCodexEndpoint(c, settings));
    const response = await app.request("/codex/fixture/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify({ model: "m", input: "hello", max_output_tokens: 100, stream: true }) });
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"hello"');
    expect(text).toContain("event: response.completed");
    expect(text).toContain('"input_tokens":10');
  });

  it.each([
    ["codex", handleCodexEndpoint],
    ["workbuddy", handleWorkbuddyEndpoint],
  ] as const)("%s auxiliary Responses endpoint remains a native passthrough", async (agent, handler) => {
    const settings = config("anthropic");
    settings.upstream.agents[agent] = { url: "https://upstream.invalid/v1", protocol: "anthropic", maxTokens: 2048 };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (isInstanceUpstreamRequest(String(url))) return Response.json({ code: 0, data: { items: [] } });
      calls.push(String(url));
      return Response.json({ compacted: true });
    }));
    const app = new Hono(); app.post(`/${agent}/fixture/v1/responses/compact`, c => handler(c, settings));
    const response = await app.request(`/${agent}/fixture/v1/responses/compact`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify({ model: "m", input: [] }) });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["https://upstream.invalid/v1/responses/compact"]);
    expect(await response.json()).toEqual({ compacted: true });
  });
  it("reports credit from raw upstream cache categories through the actual Chat handler", async () => {
    const settings = config("anthropic");
    settings.upstream.url = "https://tokenhub.invalid/v1";
    settings.creditReport.url = "https://credits.invalid/report";
    Object.assign(settings.creditPricing.models[0], { cacheRead: 0.1, cacheWrite5m: 2, cacheWrite1h: 3 });
    let credited: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).startsWith("https://credits.invalid")) { credited = JSON.parse(String(init.body)); return Response.json({ code: 0 }); }
      if (isInstanceUpstreamRequest(String(url))) return Response.json({ code: 0, data: { items: [] } });
      if (!String(url).startsWith("https://tokenhub.invalid")) throw new Error(`Unexpected fixture request ${url}`);
      return Response.json({ ...anth, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 } } });
    }));
    const app = new Hono(); app.post("/claude-code/fixture-space/v1/chat/completions", c => handleChatCompletions(c, settings));
    const response = await app.request("/claude-code/fixture-space/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(200);
    expect((await response.json()).usage.prompt_tokens).toBe(130);
    expect(credited?.CreditDelta).toBeCloseTo(0.07);
  });
  it("Chat handler sends Messages upstream and returns a Chat response", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      return Response.json(anth);
    }));
    const app = new Hono(); app.post("/v1/chat/completions", c => handleChatCompletions(c, config("anthropic")));
    const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-client-key" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://upstream.invalid/v1/messages");
    expect(calls[0].headers.get("x-api-key")).toBe("fixture-server-key");
    expect(calls[0].body).toMatchObject({ max_tokens: 1024, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] });
    expect((await response.json()).choices[0].message.content).toBe("hello");
  });
  it("Messages handler sends Chat upstream and returns a Messages response", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      return Response.json(chat);
    }));
    const app = new Hono(); app.post("/v1/messages", c => handleAnthropicMessages(c, config("chat")));
    const response = await app.request("/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "fixture-client-key" }, body: JSON.stringify({ model: "m", max_tokens: 100, messages: [{ role: "user", content: "hello" }] }) });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://upstream.invalid/v1/chat/completions");
    expect(calls[0].headers.get("authorization")).toBe("Bearer fixture-server-key");
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(await response.json()).toMatchObject({ type: "message", content: [{ type: "text", text: "hello" }] });
  });
});
