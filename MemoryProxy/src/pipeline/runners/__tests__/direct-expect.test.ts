import { Hono } from "hono";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../../../types.js";
import { runDirectPipeline } from "../direct.js";

// Keep the forwarding path and native fetch real. Stub services used for
// observability or session lookup, which have no role in the HTTP exchange.
vi.mock("../../../logger.js", () => ({ writeLog: vi.fn() }));
vi.mock("../../../opik.js", () => ({
  apiKeyToKeyId: vi.fn(),
  extractBearerToken: vi.fn(),
  opikCreateLlmSpan: vi.fn(),
  opikCreateTrace: vi.fn(),
  uuidv7: () => "test-request",
}));
vi.mock("../../../guard-adapter.js", () => ({
  resolveSessionKey: () => "test-session",
  poolServiceFor: () => ({ active: false, serviceName: "test-pool", primaryModel: null }),
}));
vi.mock("../anthropic.js", () => ({ flattenAnthropicMessagesForOpik: () => [] }));
vi.mock("../openai-chat.js", () => ({
  extractSseUsage: () => null,
  flattenMessagesForOpik: () => [],
}));

describe("direct chat upstream forwarding", () => {
  it.each([false, true])("forwards a JSON request and SSE response (Expect present: %s)", async (withExpect) => {
    const upstreamOrigin = "http://upstream.test";
    const config = {
      server: { forwardTimeoutMs: 0 },
      upstream: { url: upstreamOrigin + "/v1" },
      log: { level: "info" },
    } as ProxyConfig;
    const app = new Hono();
    app.all("/direct/*", (c) => runDirectPipeline(c, config));
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    const original = getGlobalDispatcher();

    const request = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "재시도" }],
      stream: true,
    });
    const events = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';
    let outgoing: Headers | undefined;
    let sentBody: string | undefined;
    dispatcher.get(upstreamOrigin).intercept({
      method: "POST",
      path: "/v1/chat/completions",
    }).reply(200, ({ headers, body }) => {
      outgoing = new Headers(headers as HeadersInit);
      sentBody = typeof body === "string" ? body : new TextDecoder().decode(body as ArrayBuffer);
      return events;
    }, { headers: { "content-type": "text/event-stream" } });

    setGlobalDispatcher(dispatcher);
    try {
      const response = await app.request("http://proxy.test/direct/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(withExpect ? { Expect: "100-continue" } : {}),
        },
        body: request,
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(outgoing?.has("expect")).toBe(false);
      expect(outgoing?.get("content-type")).toBe("application/json");
      expect(sentBody).toBe(request);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(text).toBe(events);
      dispatcher.assertNoPendingInterceptors();
    } finally {
      setGlobalDispatcher(original);
      await dispatcher.close();
    }
  });
});
