import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import { createApp } from "../server.js";
import type { ProxyConfig } from "../types.js";

const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("OpenAI stream finalization", () => {
  it("finalizes when the client cancels immediately after data: [DONE]", async () => {
    const upstream = createSseUpstream({ sendDone: true, keepOpen: true });
    servers.push(upstream);
    const upstreamUrl = await listen(upstream);
    const streamDoneCount = captureStreamDoneCount();
    const response = await requestStream(upstreamUrl, "stream-cancel-test");

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let received = "";
    while (!/data:\s*\[DONE\]/.test(received)) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    await reader!.cancel();

    await vi.waitFor(() => expect(streamDoneCount()).toBe(1));
  });

  it("finalizes when the client cancels after the DONE line before the blank line arrives", async () => {
    const upstream = createSseUpstream({
      sendDone: true,
      keepOpen: true,
      doneFrame: "data: [DONE]\n",
    });
    servers.push(upstream);
    const upstreamUrl = await listen(upstream);
    const streamDoneCount = captureStreamDoneCount();
    const response = await requestStream(upstreamUrl, "stream-split-done-test");

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let received = "";
    while (!/data:\s*\[DONE\]/.test(received)) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    await reader!.cancel();

    await vi.waitFor(() => expect(streamDoneCount()).toBe(1));
  });

  it("finalizes a CRLF DONE event without the optional data-field space", async () => {
    const upstream = createSseUpstream({
      sendDone: true,
      keepOpen: true,
      doneFrame: "data:[DONE]\r\n\r\n",
    });
    servers.push(upstream);
    const upstreamUrl = await listen(upstream);
    const streamDoneCount = captureStreamDoneCount();
    const response = await requestStream(upstreamUrl, "stream-crlf-done-test");

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let received = "";
    while (!/data:\s*\[DONE\]/.test(received)) {
      const chunk = await reader!.read();
      expect(chunk.done).toBe(false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    await reader!.cancel();

    await vi.waitFor(() => expect(streamDoneCount()).toBe(1));
  });

  it("finalizes once when data: [DONE] is followed by transport EOF", async () => {
    const upstream = createSseUpstream({ sendDone: true, keepOpen: false });
    servers.push(upstream);
    const upstreamUrl = await listen(upstream);
    const streamDoneCount = captureStreamDoneCount();

    const response = await requestStream(upstreamUrl, "stream-done-eof-test");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("data: [DONE]");

    await vi.waitFor(() => expect(streamDoneCount()).toBe(1));
  });

  it("finalizes once at transport EOF when the stream has no data: [DONE]", async () => {
    const upstream = createSseUpstream({ sendDone: false, keepOpen: false });
    servers.push(upstream);
    const upstreamUrl = await listen(upstream);
    const streamDoneCount = captureStreamDoneCount();

    const response = await requestStream(upstreamUrl, "stream-eof-test");
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("data: [DONE]");

    await vi.waitFor(() => expect(streamDoneCount()).toBe(1));
  });
});

function createSseUpstream(options: {
  sendDone: boolean;
  keepOpen: boolean;
  doneFrame?: string;
}): Server {
  return createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`,
    );
    if (options.sendDone) response.write(options.doneFrame ?? "data: [DONE]\n\n");
    if (!options.keepOpen) response.end();
    // A kept-open body models OpenAI-compatible clients that stop at [DONE]
    // and close the response without waiting for transport EOF.
  });
}

function captureStreamDoneCount(): () => number {
  let stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  return () => stderr.split("✓ STREAM").length - 1;
}

async function requestStream(upstreamUrl: string, conversationId: string): Promise<Response> {
  const app = createApp(testConfig(upstreamUrl));
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-conversation-id": conversationId,
    },
    body: JSON.stringify({
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

function testConfig(upstreamUrl: string): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = upstreamUrl;
  config.server.forwardTimeoutMs = 2_000;
  config.rateLimit = { tpm: 0, qpm: 0 };
  config.extraction = { enabled: false, extractors: [] };
  return config;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
