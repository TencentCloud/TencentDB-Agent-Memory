/**
 * HttpMemoryClient unit tests.
 *
 * A stub gateway (`node:http` on an ephemeral port) records every request so
 * the tests can assert the exact wire shape (paths, snake_case bodies,
 * headers) without touching a real TdaiCore. Fully offline.
 */

import http from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpMemoryClient } from "./http.js";
import { MemoryClientError } from "../errors.js";

// ============================
// Stub gateway
// ============================

interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

interface StubRoute {
  status: number;
  body: unknown;
  /** When true the route never responds (for timeout tests). */
  hang?: boolean;
}

class StubGateway {
  readonly requests: RecordedRequest[] = [];
  private readonly routes = new Map<string, StubRoute>();
  private server?: http.Server;
  private port = 0;

  route(method: string, path: string, status: number, body: unknown, opts?: { hang?: boolean }): void {
    this.routes.set(`${method} ${path}`, { status, body, hang: opts?.hang });
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        this.requests.push({
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body: raw ? JSON.parse(raw) : undefined,
        });
        const route = this.routes.get(`${req.method} ${req.url}`);
        if (!route) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `no stub for ${req.method} ${req.url}` }));
          return;
        }
        if (route.hang) return; // never respond — client must time out
        res.writeHead(route.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(route.body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.port = (this.server!.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}

// ============================
// Tests
// ============================

describe("HttpMemoryClient", () => {
  let stub: StubGateway;
  let baseUrl: string;

  beforeEach(async () => {
    stub = new StubGateway();
    baseUrl = await stub.start();
  });

  afterEach(async () => {
    await stub.stop();
  });

  it("recall: POSTs snake_case body to /recall and maps the response", async () => {
    stub.route("POST", "/recall", 200, {
      context: "ctx",
      strategy: "hybrid",
      memory_count: 3,
      prepend_context: "pre",
    });
    const client = new HttpMemoryClient({ baseUrl });

    const outcome = await client.recall({ query: "hello", sessionKey: "s1", userId: "u1" });

    expect(outcome).toEqual({
      context: "ctx",
      prependContext: "pre",
      strategy: "hybrid",
      memoryCount: 3,
    });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].path).toBe("/recall");
    expect(stub.requests[0].body).toEqual({ query: "hello", session_key: "s1", user_id: "u1" });
    expect(stub.requests[0].headers["content-type"]).toBe("application/json");
  });

  it("recall: tolerates legacy gateways that omit prepend_context", async () => {
    stub.route("POST", "/recall", 200, { context: "ctx", strategy: "fts", memory_count: 1 });
    const client = new HttpMemoryClient({ baseUrl });

    const outcome = await client.recall({ query: "hello", sessionKey: "s1" });

    expect(outcome.prependContext).toBeUndefined();
    expect(outcome.context).toBe("ctx");
  });

  it("capture: maps camelCase params to gateway wire names", async () => {
    stub.route("POST", "/capture", 200, { l0_recorded: 2, scheduler_notified: true });
    const client = new HttpMemoryClient({ baseUrl });

    const outcome = await client.capture({
      userContent: "u-text",
      assistantContent: "a-text",
      sessionKey: "s1",
      sessionId: "sid-9",
      messages: [{ role: "user", content: "u-text" }],
    });

    expect(outcome).toEqual({ l0Recorded: 2, schedulerNotified: true });
    expect(stub.requests[0].body).toEqual({
      user_content: "u-text",
      assistant_content: "a-text",
      session_key: "s1",
      session_id: "sid-9",
      messages: [{ role: "user", content: "u-text" }],
    });
  });

  it("capture: omits optional fields not provided", async () => {
    stub.route("POST", "/capture", 200, { l0_recorded: 0, scheduler_notified: false });
    const client = new HttpMemoryClient({ baseUrl });

    await client.capture({ userContent: "u", assistantContent: "a", sessionKey: "s" });

    expect(stub.requests[0].body).toEqual({
      user_content: "u",
      assistant_content: "a",
      session_key: "s",
    });
  });

  it("searchMemories: sends include_items:true and returns structured items", async () => {
    const items = [
      {
        id: "m1", content: "likes tea", type: "persona", priority: 1,
        scene_name: "daily", score: 0.9, created_at: "2026-01-01", updated_at: "2026-01-02",
      },
    ];
    stub.route("POST", "/search/memories", 200, {
      results: "Found 1 matching memories:", total: 1, strategy: "hybrid", items,
    });
    const client = new HttpMemoryClient({ baseUrl });

    const outcome = await client.searchMemories({ query: "tea", limit: 5, type: "persona", scene: "daily" });

    expect(outcome.text).toBe("Found 1 matching memories:");
    expect(outcome.total).toBe(1);
    expect(outcome.strategy).toBe("hybrid");
    expect(outcome.items).toEqual(items);
    expect(stub.requests[0].body).toEqual({
      query: "tea", limit: 5, type: "persona", scene: "daily", include_items: true,
    });
  });

  it("searchMemories: tolerates gateways that omit items (older protocol)", async () => {
    stub.route("POST", "/search/memories", 200, { results: "text only", total: 2, strategy: "fts" });
    const client = new HttpMemoryClient({ baseUrl });

    const outcome = await client.searchMemories({ query: "q" });

    expect(outcome.items).toEqual([]);
    expect(outcome.total).toBe(2);
  });

  it("searchConversations: maps sessionKey → session_key and returns items", async () => {
    const items = [
      { id: "c1", session_key: "s1", role: "user", content: "hi", score: 0.5, recorded_at: "2026-01-01" },
    ];
    stub.route("POST", "/search/conversations", 200, { results: "found", total: 1, items });
    const client = new HttpMemoryClient({ baseUrl });

    const outcome = await client.searchConversations({ query: "hi", limit: 3, sessionKey: "s1" });

    expect(outcome).toEqual({ text: "found", total: 1, items });
    expect(stub.requests[0].body).toEqual({
      query: "hi", limit: 3, session_key: "s1", include_items: true,
    });
  });

  it("endSession: POSTs session_key to /session/end", async () => {
    stub.route("POST", "/session/end", 200, { flushed: true });
    const client = new HttpMemoryClient({ baseUrl });

    await client.endSession("s-end");

    expect(stub.requests[0].path).toBe("/session/end");
    expect(stub.requests[0].body).toEqual({ session_key: "s-end" });
  });

  it("health: GETs /health and maps store flags", async () => {
    stub.route("GET", "/health", 200, {
      status: "ok", version: "0.1.0", uptime: 12,
      stores: { vectorStore: true, embeddingService: false },
    });
    const client = new HttpMemoryClient({ baseUrl });

    const outcome = await client.health();

    expect(outcome).toEqual({
      status: "ok", vectorStore: true, embeddingService: false, version: "0.1.0",
    });
    expect(stub.requests[0].method).toBe("GET");
    // GET carries no body and no content-type
    expect(stub.requests[0].headers["content-type"]).toBeUndefined();
  });

  it("attaches Authorization: Bearer only when apiKey is non-empty after trim", async () => {
    stub.route("GET", "/health", 200, { status: "ok", stores: {} });
    await new HttpMemoryClient({ baseUrl, apiKey: " secret-key " }).health();
    await new HttpMemoryClient({ baseUrl, apiKey: "   " }).health();
    await new HttpMemoryClient({ baseUrl }).health();

    expect(stub.requests[0].headers["authorization"]).toBe("Bearer secret-key");
    expect(stub.requests[1].headers["authorization"]).toBeUndefined();
    expect(stub.requests[2].headers["authorization"]).toBeUndefined();
  });

  it("maps HTTP 401 to MemoryClientError code 'auth' and surfaces the error body", async () => {
    stub.route("POST", "/recall", 401, { error: "Unauthorized: invalid token" });
    const client = new HttpMemoryClient({ baseUrl });

    const err = await client.recall({ query: "q", sessionKey: "s" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemoryClientError);
    expect((err as MemoryClientError).code).toBe("auth");
    expect((err as MemoryClientError).httpStatus).toBe(401);
    expect((err as MemoryClientError).message).toContain("Unauthorized: invalid token");
  });

  it("maps HTTP 400 to 'bad_request' and HTTP 500 to 'transport'", async () => {
    stub.route("POST", "/recall", 400, { error: "Missing required fields: query, session_key" });
    stub.route("POST", "/capture", 500, { error: "boom" });
    const client = new HttpMemoryClient({ baseUrl });

    const badReq = await client.recall({ query: "q", sessionKey: "s" }).catch((e: unknown) => e);
    const serverErr = await client
      .capture({ userContent: "u", assistantContent: "a", sessionKey: "s" })
      .catch((e: unknown) => e);

    expect((badReq as MemoryClientError).code).toBe("bad_request");
    expect((serverErr as MemoryClientError).code).toBe("transport");
    expect((serverErr as MemoryClientError).httpStatus).toBe(500);
  });

  it("times out via AbortSignal and reports a 'transport' error", async () => {
    stub.route("POST", "/recall", 200, {}, { hang: true });
    const client = new HttpMemoryClient({ baseUrl, timeoutMs: 100 });

    const err = await client.recall({ query: "q", sessionKey: "s" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemoryClientError);
    expect((err as MemoryClientError).code).toBe("transport");
    expect((err as MemoryClientError).message).toContain("timed out");
  });

  it("reports 'unavailable' when the gateway is unreachable", async () => {
    // Point at the stub's port after shutting it down — connection refused.
    await stub.stop();
    const client = new HttpMemoryClient({ baseUrl, timeoutMs: 1_000 });

    const err = await client.health().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MemoryClientError);
    expect((err as MemoryClientError).code).toBe("unavailable");
  });

  it("close() is a no-op that resolves", async () => {
    const client = new HttpMemoryClient({ baseUrl });
    await expect(client.close()).resolves.toBeUndefined();
  });
});
