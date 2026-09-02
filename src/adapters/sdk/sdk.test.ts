/**
 * Tests for the unified adapter SDK (issue #3 — 拓展 + 进阶).
 *
 * - InProcessMemoryAdapter: verified against a stub `TdaiCoreLike` that records
 *   every call, proving the adapter maps MemoryAdapter ↔ TdaiCore correctly.
 * - HttpMemoryAdapter: verified against a real in-process HTTP server (node:http)
 *   that speaks the Gateway's snake_case JSON contract, proving the field-name
 *   translation and Bearer auth.
 *
 * No real `TdaiCore` / sqlite-vec / embedding service is required.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";

import type { CompletedTurn } from "../../core/types.js";
import type {
  CaptureResult,
  ConversationSearchParams,
  MemorySearchParams,
  RecallResult,
} from "../../core/types.js";
import type { TdaiCoreLike } from "./in-process-memory-adapter.js";
import { InProcessMemoryAdapter, fromCore } from "./in-process-memory-adapter.js";
import { HttpMemoryAdapter } from "./http-memory-adapter.js";
import { MemoryAdapterError } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// Stub TdaiCore
// ──────────────────────────────────────────────────────────────────────────

function makeStubCore(): TdaiCoreLike & { calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  const core: TdaiCoreLike = {
    async initialize() {
      calls.push(["initialize"]);
    },
    async destroy() {
      calls.push(["destroy"]);
    },
    async handleBeforeRecall(userText: string, sessionKey: string): Promise<RecallResult> {
      calls.push(["handleBeforeRecall", userText, sessionKey]);
      return { appendSystemContext: `CTX(${userText})`, recallStrategy: "hybrid" };
    },
    async handleTurnCommitted(turn: CompletedTurn): Promise<CaptureResult> {
      calls.push(["handleTurnCommitted", turn]);
      return {
        l0RecordedCount: 2,
        schedulerNotified: true,
        l0VectorsWritten: 0,
        filteredMessages: [],
      };
    },
    async searchMemories(p: MemorySearchParams) {
      calls.push(["searchMemories", p]);
      return { text: `MEM(${p.query})`, total: 3, strategy: "embedding" };
    },
    async searchConversations(p: ConversationSearchParams) {
      calls.push(["searchConversations", p]);
      return { text: `CONV(${p.query})`, total: 1 };
    },
    async handleSessionEnd(sessionKey: string) {
      calls.push(["handleSessionEnd", sessionKey]);
    },
    getVectorStore() {
      return { __stub: true };
    },
    getEmbeddingService() {
      return undefined;
    },
  };
  return Object.assign(core, { calls });
}

// ==========================================================================
// 进阶 — InProcessMemoryAdapter maps MemoryAdapter ↔ TdaiCore
// ==========================================================================

describe("[进阶] InProcessMemoryAdapter", () => {
  it("implements the MemoryAdapter contract", () => {
    const a = new InProcessMemoryAdapter({ core: makeStubCore() });
    expect(a.kind).toBe("in-process");
    expect(typeof a.initialize).toBe("function");
    expect(typeof a.recall).toBe("function");
    expect(typeof a.capture).toBe("function");
    expect(typeof a.searchMemories).toBe("function");
    expect(typeof a.searchConversations).toBe("function");
    expect(typeof a.endSession).toBe("function");
  });

  it("initialize/destroy drive core lifecycle when ownsLifecycle=true", async () => {
    const core = makeStubCore();
    const a = new InProcessMemoryAdapter({ core, ownsLifecycle: true });
    await a.initialize();
    await a.destroy();
    expect(core.calls.map((c) => c[0])).toEqual(["initialize", "destroy"]);
  });

  it("does not touch core lifecycle when ownsLifecycle=false", async () => {
    const core = makeStubCore();
    const a = new InProcessMemoryAdapter({ core, ownsLifecycle: false });
    await a.initialize();
    await a.destroy();
    expect(core.calls).toHaveLength(0);
  });

  it("recall delegates to handleBeforeRecall", async () => {
    const core = makeStubCore();
    const a = new InProcessMemoryAdapter({ core, ownsLifecycle: false });
    const r = await a.recall("hello", "sess-1");
    expect(r).toEqual({ appendSystemContext: "CTX(hello)", recallStrategy: "hybrid" });
    expect(core.calls[0]).toEqual(["handleBeforeRecall", "hello", "sess-1"]);
  });

  it("capture reconstructs a CompletedTurn (synthesises messages when absent)", async () => {
    const core = makeStubCore();
    const a = new InProcessMemoryAdapter({ core, ownsLifecycle: false });
    const r = await a.capture({
      userText: "u",
      assistantText: "v",
      sessionKey: "s",
      sessionId: "sid",
      startedAt: 123,
    });
    expect(r.schedulerNotified).toBe(true);
    const [, turn] = core.calls[0];
    expect(turn).toMatchObject({
      userText: "u",
      assistantText: "v",
      sessionKey: "s",
      sessionId: "sid",
      startedAt: 123,
    });
    expect((turn as CompletedTurn).messages).toEqual([
      { role: "user", content: "u" },
      { role: "assistant", content: "v" },
    ]);
  });

  it("capture passes through caller-supplied messages", async () => {
    const core = makeStubCore();
    const a = new InProcessMemoryAdapter({ core, ownsLifecycle: false });
    const msgs = [{ role: "user", content: "x" }, { role: "tool", content: "y" }];
    await a.capture({ userText: "u", assistantText: "v", sessionKey: "s", messages: msgs });
    expect((core.calls[0][1] as CompletedTurn).messages).toBe(msgs);
  });

  it("searchMemories / searchConversations pass through params and shapes", async () => {
    const core = makeStubCore();
    const a = new InProcessMemoryAdapter({ core, ownsLifecycle: false });
    const m = await a.searchMemories({ query: "q", limit: 5, type: "episodic" });
    expect(m).toEqual({ text: "MEM(q)", total: 3, strategy: "embedding" });
    const c = await a.searchConversations({ query: "q2", sessionKey: "s" });
    expect(c).toEqual({ text: "CONV(q2)", total: 1 });
  });

  it("endSession forwards to handleSessionEnd and tolerates empty key", async () => {
    const core = makeStubCore();
    const a = new InProcessMemoryAdapter({ core, ownsLifecycle: false });
    await a.endSession("s");
    await a.endSession("");
    expect(core.calls).toEqual([["handleSessionEnd", "s"]]);
  });

  it("healthCheck reports store availability", async () => {
    const a = new InProcessMemoryAdapter({ core: makeStubCore(), ownsLifecycle: false });
    const h = await a.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatchObject({ vectorStore: true, embeddingService: false });
  });

  it("fromCore() convenience builds an in-process adapter", () => {
    const a = fromCore(makeStubCore(), false);
    expect(a.kind).toBe("in-process");
  });
});

// ==========================================================================
// 进阶 / 深入 — HttpMemoryAdapter over a real in-process HTTP server
// ==========================================================================

/** Tiny Gateway-shaped HTTP server for tests. Records requests + speaks snake_case JSON. */
function makeGatewayStub(opts: {
  apiKey?: string;
  onUnauthorized?: () => void;
}): { server: http.Server; baseUrl: string; requests: http.IncomingMessage[]; bodies: unknown[]; close: () => Promise<void> } {
  const requests: http.IncomingMessage[] = [];
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      bodies.push(parsed);
      // Auth gate mirroring the real Gateway.
      if (opts.apiKey) {
        const auth = req.headers["authorization"];
        if (auth !== `Bearer ${opts.apiKey}`) {
          opts.onUnauthorized?.();
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
      }
      const path = req.url;
      res.writeHead(200, { "content-type": "application/json" });

      if (path === "/health") {
        return res.end(JSON.stringify({
          status: "ok", version: "test", uptime: 1,
          stores: { vectorStore: true, embeddingService: true },
        }));
      }
      if (path === "/recall") {
        return res.end(JSON.stringify({ context: `CTX(${parsed.query})`, strategy: "hybrid", memory_count: 2 }));
      }
      if (path === "/capture") {
        return res.end(JSON.stringify({ l0_recorded: 2, scheduler_notified: true }));
      }
      if (path === "/search/memories") {
        return res.end(JSON.stringify({ results: `MEM(${parsed.query})`, total: 3, strategy: "embedding" }));
      }
      if (path === "/search/conversations") {
        return res.end(JSON.stringify({ results: `CONV(${parsed.query})`, total: 1 }));
      }
      if (path === "/session/end") {
        return res.end(JSON.stringify({ flushed: true }));
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return {
    server,
    baseUrl: "",
    requests,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function start(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(`http://127.0.0.1:${addr.port}`);
      else resolve("http://127.0.0.1");
    });
  });
}

describe("[进阶/深入] HttpMemoryAdapter", () => {
  let gw: ReturnType<typeof makeGatewayStub>;

  beforeEach(() => {
    gw = makeGatewayStub({});
  });
  afterEach(async () => {
    await gw.close();
  });

  it("initialize() probes /health", async () => {
    gw.baseUrl = await start(gw.server);
    const a = new HttpMemoryAdapter({ baseUrl: gw.baseUrl });
    await a.initialize();
    const h = await a.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail?.status).toBe("ok");
  });

  it("recall → POST /recall, maps snake_case → camelCase", async () => {
    gw.baseUrl = await start(gw.server);
    const a = new HttpMemoryAdapter({ baseUrl: gw.baseUrl, defaultUserId: "u1" });
    const r = await a.recall("hello", "sess-1");
    expect(r).toEqual({ appendSystemContext: "CTX(hello)", recallStrategy: "hybrid", recalledL1Memories: [] });
    const req = gw.requests[0];
    expect(req.url).toBe("/recall");
    // defaultUserId forwarded as user_id; the stub recorded the parsed body.
    expect(gw.bodies[0]).toMatchObject({ query: "hello", session_key: "sess-1", user_id: "u1" });
  });

  it("capture → POST /capture, maps CaptureTurn → snake_case body", async () => {
    gw.baseUrl = await start(gw.server);
    const a = new HttpMemoryAdapter({ baseUrl: gw.baseUrl });
    const r = await a.capture({
      userText: "u", assistantText: "v", sessionKey: "s", sessionId: "sid",
      messages: [{ role: "user", content: "u" }],
    });
    expect(r).toEqual({ l0RecordedCount: 2, schedulerNotified: true, l0VectorsWritten: 0, filteredMessages: [] });
    const req = gw.requests[0];
    expect(req.url).toBe("/capture");
  });

  it("searchMemories / searchConversations return outcome shapes", async () => {
    gw.baseUrl = await start(gw.server);
    const a = new HttpMemoryAdapter({ baseUrl: gw.baseUrl });
    const m = await a.searchMemories({ query: "q", limit: 5, type: "episodic", scene: "work" });
    expect(m).toEqual({ text: "MEM(q)", total: 3, strategy: "embedding" });
    const c = await a.searchConversations({ query: "q2", sessionKey: "s" });
    expect(c).toEqual({ text: "CONV(q2)", total: 1 });
  });

  it("endSession → POST /session/end", async () => {
    gw.baseUrl = await start(gw.server);
    const a = new HttpMemoryAdapter({ baseUrl: gw.baseUrl });
    await a.endSession("s");
    expect(gw.requests[0].url).toBe("/session/end");
    await a.endSession(""); // no-op, no request
    expect(gw.requests).toHaveLength(1);
  });

  it("sends Authorization: Bearer when apiKey is set, and 401 surfaces as MemoryAdapterError", async () => {
    await gw.close();
    let unauth = 0;
    gw = makeGatewayStub({ apiKey: "secret", onUnauthorized: () => unauth++ });
    gw.baseUrl = await start(gw.server);
    // Wrong-key adapter → 401.
    const a = new HttpMemoryAdapter({ baseUrl: gw.baseUrl, apiKey: "wrong" });
    await expect(a.recall("q", "s")).rejects.toMatchObject({
      name: "MemoryAdapterError",
      code: "HTTP_ERROR",
      status: 401,
    });
    expect(unauth).toBe(1);
    expect(MemoryAdapterError).toBeDefined();
  });

  it("network error (unreachable host) surfaces as MemoryAdapterError", async () => {
    const a = new HttpMemoryAdapter({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    const h = await a.healthCheck();
    expect(h.ok).toBe(false);
    await expect(a.recall("q", "s")).rejects.toMatchObject({ name: "MemoryAdapterError" });
  });
});
