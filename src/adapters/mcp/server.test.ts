/**
 * End-to-end test for the stdio MCP transport: real newline-delimited JSON-RPC
 * flows through fake streams into a Gateway-backed dispatcher (with a fake
 * fetch), exercising framing, ordering, and parse-error handling.
 */

import { describe, it, expect } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { createMemoryMcpServer } from "./server.js";
import { GatewayMemoryAdapter } from "../../sdk/memory-adapter.js";

/** Collect everything written to output and expose parsed JSON-RPC lines. */
function collector() {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    output,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l)),
  };
}

/** A fake fetch mapping Gateway routes to canned JSON responses. */
function gatewayFetch(): typeof fetch {
  return (async (url: string) => {
    const path = new URL(String(url)).pathname;
    const bodies: Record<string, unknown> = {
      "/health": { status: "ok", version: "test", uptime: 1, stores: { vectorStore: true, embeddingService: true } },
      "/search/memories": { results: "• user likes tea", total: 1, strategy: "hybrid" },
    };
    return new Response(JSON.stringify(bodies[path] ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function runSession(inputLines: string[]) {
  const input = new PassThrough();
  const { output, lines } = collector();
  const adapter = new GatewayMemoryAdapter({ fetch: gatewayFetch() });

  const server = createMemoryMcpServer({
    adapter,
    streams: { input, output, log: () => {} },
  });
  const done = server.start();

  for (const line of inputLines) input.write(line + "\n");
  input.end();
  await done;
  // Allow the serialized write chain to flush.
  await new Promise((r) => setTimeout(r, 10));
  return lines();
}

describe("StdioMcpServer (end-to-end)", () => {
  it("handles a full initialize → list → call handshake", async () => {
    const responses = await runSession([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tdai_memory_search", arguments: { query: "drink" } } }),
    ]);

    // The notification produces no response → 3 responses for 4 inputs.
    expect(responses).toHaveLength(3);

    const init = responses.find((r) => r.id === 1);
    expect(init.result.serverInfo.name).toBe("tdai-memory");

    const list = responses.find((r) => r.id === 2);
    expect(list.result.tools.length).toBeGreaterThanOrEqual(2);

    const call = responses.find((r) => r.id === 3);
    expect(call.result.isError).toBe(false);
    expect(call.result.content[0].text).toContain("tea");
  });

  it("emits a JSON-RPC parse error for malformed input lines", async () => {
    const responses = await runSession(["{ this is not json"]);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("drains an in-flight tool call when stdin closes before it resolves", async () => {
    // A slow adapter: the response only becomes available well after input.end().
    // If shutdown did not drain pending work, this response would be lost.
    const slowAdapter = new GatewayMemoryAdapter({ fetch: gatewayFetch() });
    const original = slowAdapter.searchMemories.bind(slowAdapter);
    slowAdapter.searchMemories = async (input) => {
      await new Promise((r) => setTimeout(r, 40));
      return original(input);
    };

    const input = new PassThrough();
    const { output, lines } = collector();
    const server = createMemoryMcpServer({ adapter: slowAdapter, streams: { input, output, log: () => {} } });
    const done = server.start();

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tdai_memory_search", arguments: { query: "drink" } } }) + "\n");
    input.end(); // stdin closes immediately — the 40ms handler is still running

    await done; // start() must not resolve until the handler drains
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ id: 1, result: { isError: false } });
  });

  it("processes two messages arriving in a single chunk", async () => {    // Both JSON objects are written before any newline flush boundary — the
    // buffer splitter must still surface both.
    const input = new PassThrough();
    const { output, lines } = collector();
    const server = createMemoryMcpServer({
      adapter: new GatewayMemoryAdapter({ fetch: gatewayFetch() }),
      streams: { input, output, log: () => {} },
    });
    const done = server.start();
    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n",
    );
    input.end();
    await done;
    await new Promise((r) => setTimeout(r, 10));
    expect(lines().map((r) => r.id).sort()).toEqual([1, 2]);
  });
});
