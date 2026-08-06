import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import type { ProxyConfig } from "../types.js";

function createTestConfig(): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream = {
    url: "https://upstream.example/v1",
    apiKey: "upstream-key",
    agents: {},
  };
  return config;
}

function codexRequest(body: Record<string, unknown>): Request {
  return new Request("http://proxy.test/codex/demo/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer memory-user-key",
      "content-type": "application/json",
      "session-id": "codex-session",
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native Codex Responses route", () => {
  it("forwards a non-stream Responses request without leaking the Memory key", async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [],
    }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", upstream);

    const app = createApp(createTestConfig());
    const response = await app.fetch(codexRequest({
      model: "gpt-5.6-sol",
      stream: false,
      input: "Return a short answer",
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: "response", status: "completed" });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[0]).toBe("https://upstream.example/v1/responses");

    const request = upstream.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toBe("Bearer upstream-key");
    expect(headers.get("session-id")).toBe("codex-session");
    expect(await new Response(request.body).json()).toMatchObject({
      model: "gpt-5.6-sol",
      input: "Return a short answer",
    });
  });

  it("relays Codex SSE bytes unchanged", async () => {
    const sse = [
      "event: response.output_text.delta\n",
      "data: {\"delta\":\"CODEX_SSE_OK\"}\n\n",
      "event: response.completed\n",
      "data: {\"response\":{\"output\":[]}}\n\n",
    ].join("");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    })));

    const app = createApp(createTestConfig());
    const response = await app.fetch(codexRequest({
      model: "gpt-5.6-sol",
      stream: true,
      input: "Stream a short answer",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(sse);
  });
});
