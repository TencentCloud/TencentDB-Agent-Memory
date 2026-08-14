import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelMemoryProxy } from "./server.js";
import type {
  CapturePayload,
  ModelProxyGateway,
} from "./types.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
});

async function startUpstream(
  handler: http.RequestListener,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  closeCallbacks.push(close);
  return { origin: `http://127.0.0.1:${address.port}`, close };
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function fakeGateway(options?: {
  recall?: ModelProxyGateway["recall"];
}): {
  gateway: ModelProxyGateway;
  captures: CapturePayload[];
  ended: string[];
} {
  const captures: CapturePayload[] = [];
  const ended: string[] = [];
  return {
    captures,
    ended,
    gateway: {
      recall: options?.recall ?? vi.fn(async () => ({
        prepend_context: "The user prefers TypeScript.",
      })),
      capture: vi.fn(async (payload) => {
        captures.push(payload);
        return {};
      }),
      endSession: vi.fn(async ({ session_key }) => {
        ended.push(session_key);
        return {};
      }),
    },
  };
}

async function startProxy(
  upstreamBaseUrl: string,
  gateway: ModelProxyGateway,
): Promise<{ url: string; proxy: ModelMemoryProxy }> {
  const proxy = new ModelMemoryProxy({
    upstreamBaseUrl,
    gateway,
    sessionSecret: "test-secret",
    outboxPath: ":memory:",
    sessionIdleMs: 60_000,
  });
  const address = await proxy.listen({ port: 0 });
  closeCallbacks.push(() => proxy.close());
  return {
    proxy,
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
  };
}

describe("ModelMemoryProxy", () => {
  it("injects recall into the upstream copy and captures the pristine turn", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const upstream = await startUpstream(async (request, response) => {
      upstreamBody = await readJson(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-1",
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "Use an interface." },
        }],
      }));
    });
    const { gateway, captures } = fakeGateway();
    const { proxy, url } = await startProxy(upstream.origin, gateway);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer upstream-secret",
        "x-tdai-session-key": "conversation-1",
      },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "How should I type this?" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "chatcmpl-1" });
    await proxy.drainCaptures();

    const upstreamMessages = upstreamBody?.messages as Array<{ content: string }>;
    expect(upstreamMessages[0].content).toContain("<tdai-memory>");
    expect(upstreamMessages[0].content).toContain("prefers TypeScript");
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      user_content: "How should I type this?",
      assistant_content: "Use an interface.",
      session_key: "conversation-1",
    });
    expect(JSON.stringify(captures[0].messages)).not.toContain("<tdai-memory>");
  });

  it("passes SSE through and captures only a terminal text answer", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"Hello "},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const upstream = await startUpstream(async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) response.write(frame);
      response.end();
    });
    const { gateway, captures } = fakeGateway();
    const { proxy, url } = await startProxy(upstream.origin, gateway);

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test",
        stream: true,
        messages: [{ role: "user", content: "greet me" }],
      }),
    });
    expect(await response.text()).toBe(frames.join(""));
    await proxy.drainCaptures();
    expect(captures).toHaveLength(1);
    expect(captures[0].assistant_content).toBe("Hello world");
  });

  it("fails open when recall is unavailable", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const upstream = await startUpstream(async (request, response) => {
      upstreamBody = await readJson(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "still works" },
        }],
      }));
    });
    const { gateway } = fakeGateway({
      recall: vi.fn(async () => {
        throw new Error("gateway down");
      }),
    });
    const { url } = await startProxy(upstream.origin, gateway);

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(200);
    const upstreamMessages = upstreamBody?.messages as Array<{ content: string }>;
    expect(upstreamMessages[0].content).toBe("hello");
  });

  it("does not capture intermediate tool-call responses", async () => {
    const upstream = await startUpstream(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{}" },
            }],
          },
        }],
      }));
    });
    const { gateway, captures } = fakeGateway();
    const { proxy, url } = await startProxy(upstream.origin, gateway);

    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "look it up" }],
      }),
    });
    await proxy.drainCaptures();
    expect(captures).toHaveLength(0);
  });

  it("orders shutdown as capture before session flush", async () => {
    const upstream = await startUpstream(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          finish_reason: "stop",
          message: { role: "assistant", content: "final answer" },
        }],
      }));
    });
    const events: string[] = [];
    const gateway: ModelProxyGateway = {
      recall: vi.fn(async () => ({})),
      capture: vi.fn(async () => {
        events.push("capture");
        return {};
      }),
      endSession: vi.fn(async () => {
        events.push("end");
        return {};
      }),
    };
    const { proxy, url } = await startProxy(upstream.origin, gateway);

    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-session-key": "ordered-session",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "finish correctly" }],
      }),
    });
    await proxy.close();
    expect(events).toEqual(["capture", "end"]);
  });
});
