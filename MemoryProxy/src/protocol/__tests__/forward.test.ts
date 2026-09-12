import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../config.js";
import { prepareProtocolRequest, convertProtocolResponse, fetchProtocolAttempt, type ForwardProtocolContext } from "../forward.js";
import { vi } from "vitest";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) { unlinkSync(join(path, "config.json")); rmdirSync(path); } });
afterEach(() => vi.unstubAllGlobals());
function configFile(upstream: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "protocol-config-")); directories.push(dir);
  const path = join(dir, "config.json"); writeFileSync(path, JSON.stringify({ upstream })); return path;
}
describe("explicit upstream protocol configuration", () => {
  it("retains one target protocol and model output fallback with per-agent credentials", () => {
    const config = buildConfig({ configFile: configFile({ url: "https://example.invalid/v1", apiKey: "global-fixture", protocol: "chat", agents: { codex: { url: "https://example.invalid/v1/messages", protocol: "anthropic", maxTokens: 8192, allowCacheControlDrop: true } } }) });
    expect(config.upstream).toMatchObject({ protocol: "chat", agents: { codex: { protocol: "anthropic", maxTokens: 8192, allowCacheControlDrop: true } } });
    expect(config.upstream.agents.codex.apiKey).toBeUndefined();
  });
  it("rejects unknown protocols and invalid token fallbacks at configuration load", () => {
    expect(() => buildConfig({ configFile: configFile({ protocol: "guess" }) })).toThrow(/protocol/);
    expect(() => buildConfig({ configFile: configFile({ protocol: "anthropic", maxTokens: -1 }) })).toThrow(/maxTokens/);
  });
});

describe("request conversion at the actual forwarding boundary", () => {
  const body = { model: "m", max_tokens: 100, messages: [{ role: "user", content: "hello" }] };
  it("rewrites only a known inference endpoint and rebuilds target authentication", () => {
    const result = prepareProtocolRequest({ body, from: "chat", to: "anthropic", url: "https://example.invalid/v1/chat/completions?route=a", headers: { authorization: "Bearer fixture", "x-api-key": "stale", "content-length": "10", "openai-beta": "responses=v1" } });
    expect(result.url).toBe("https://example.invalid/v1/messages?route=a");
    expect(result.headers.get("x-api-key")).toBe("fixture");
    expect(result.headers.get("authorization")).toBeNull();
    expect(result.headers.get("content-length")).toBeNull();
    expect(result.headers.get("openai-beta")).toBeNull();
    expect(result.body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });
  it("uses actual route credentials over client headers", () => {
    const result = prepareProtocolRequest({ body, from: "chat", to: "anthropic", url: "https://example.invalid/v1/messages", headers: { authorization: "Bearer client" }, authHeaders: { "x-api-key": "route-key" } });
    expect(result.headers.get("x-api-key")).toBe("route-key");
    expect(result.url).toBe("https://example.invalid/v1/messages");
  });
  it("refuses compact/count_tokens rather than converting them into text generation", () => {
    for (const path of ["/v1/responses/compact", "/v1/messages/count_tokens"]) {
      expect(() => prepareProtocolRequest({ body, from: "responses", to: "anthropic", url: `https://example.invalid${path}`, headers: {} })).toThrow(/endpoint/);
    }
  });
  it("leaves unconverted native bodies and endpoint URLs untouched", () => {
    const result = prepareProtocolRequest({ body, from: "chat", to: "chat", url: "https://example.invalid/custom", headers: {} });
    expect(result.body).toBe(body);
    expect(result.url).toBe("https://example.invalid/custom");
  });
});

describe("upstream response conversion", () => {
  it("captures raw usage before projecting JSON to the client schema", async () => {
    const raw = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 };
    const upstream = Response.json({ id: "msg_a", model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }], usage: raw }, { headers: { "content-length": "999", "content-encoding": "gzip", "x-request-id": "request-a" } });
    let captured: unknown;
    const result = await convertProtocolResponse(upstream, "anthropic", "chat", { stream: false }, { onUsage: value => { captured = value; } });
    expect(captured).toEqual(raw);
    expect((await result.json()).usage.prompt_tokens).toBe(130);
    expect(result.headers.get("content-length")).toBeNull();
    expect(result.headers.get("content-encoding")).toBeNull();
    expect(result.headers.get("x-request-id")).toBe("request-a");
  });
  it("converts an HTTP failure independently of the requested streaming mode", async () => {
    const upstream = Response.json({ error: { message: "rate limited" } }, { status: 429, headers: { "retry-after": "3" } });
    const result = await convertProtocolResponse(upstream, "chat", "anthropic", { stream: true });
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("3");
    expect(await result.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } });
  });
  it("rejects a successful but mismatched response format rather than passing wrong wire data", async () => {
    const response = await convertProtocolResponse(Response.json({ choices: [] }), "chat", "anthropic", { stream: true });
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toMatch(/stream/i);
  });
});

describe("each route attempt is encoded from the native injected request", () => {
  it("re-encodes a Chat request independently for an Anthropic first attempt and Chat retry", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      return calls.length === 1 ? Response.json({ error: { message: "try fallback" } }, { status: 400 }) : Response.json({ id: "chat", model: "fallback", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }));
    const native = { model: "requested", messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: false };
    const context: ForwardProtocolContext = { source: "chat", settings: { protocol: "anthropic" }, defaultUrl: "https://example.invalid/v1/chat/completions", request: native, warn() {} };
    await fetchProtocolAttempt({ url: context.defaultUrl, model: "routed" }, { method: "POST", headers: { authorization: "Bearer client" }, body: JSON.stringify(native) }, context);
    const response = await fetchProtocolAttempt({ url: "https://example.invalid/v1/chat/completions", model: "fallback", wireProtocol: "chat", authHeaders: { authorization: "Bearer retry" } }, { method: "POST", headers: { authorization: "Bearer client" }, body: JSON.stringify(native) }, context);
    expect(calls[0]).toMatchObject({ url: "https://example.invalid/v1/messages", body: { model: "routed", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] } });
    expect(calls[1].body).toEqual(native);
    expect(calls[1].headers.get("authorization")).toBe("Bearer retry");
    expect((await response.json()).choices[0].message.content).toBe("ok");
    expect(context.actual).toMatchObject({ protocol: "chat", model: "fallback", converted: false });
  });
  it("requires a dynamic route to declare its wire protocol when conversion is enabled", async () => {
    const context: ForwardProtocolContext = { source: "chat", settings: { protocol: "anthropic" }, defaultUrl: "https://default.invalid/v1/chat/completions", request: { model: "m", messages: [], max_tokens: 1 }, warn() {} };
    await expect(fetchProtocolAttempt({ url: "https://router.invalid/v1/messages", model: "m" }, { method: "POST" }, context)).rejects.toThrow(/wireProtocol/);
  });
  it("passes client cancellation through the combined upstream signal", async () => {
    const client = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return Response.json({ id: "msg", model: "m", stop_reason: "end_turn", content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    }));
    const native = { model: "m", messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: false };
    await fetchProtocolAttempt(
      { url: "https://example.invalid/v1/messages", model: "m" },
      { method: "POST", headers: { authorization: "Bearer fixture" } },
      { source: "chat", settings: { protocol: "anthropic" }, defaultUrl: "https://example.invalid/v1/messages", request: native, signal: client.signal, warn() {} },
    );
    expect(upstreamSignal?.aborted).toBe(false);
    client.abort();
    expect(upstreamSignal?.aborted).toBe(true);
  });
});
