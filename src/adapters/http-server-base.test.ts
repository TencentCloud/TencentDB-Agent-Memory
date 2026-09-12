import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { HttpServerBase } from "./http-server-base.js";
import type { HttpServerBaseOptions } from "./http-server-base.js";
import type { HostAdapter } from "../core/types.js";
import { MemoryOperations } from "./memory-operations.js";
import type { TdaiCore } from "../core/tdai-core.js";

// ============================
// Harness
// ============================

function makeCore() {
  return {
    handleBeforeRecall: vi.fn().mockResolvedValue({
      appendSystemContext: "remembered context",
      recalledL1Memories: [{ content: "m", score: 1, type: "episodic" }],
      recallStrategy: "hybrid",
    }),
    handleTurnCommitted: vi.fn().mockResolvedValue({
      l0RecordedCount: 2,
      schedulerNotified: true,
      l0VectorsWritten: 2,
      filteredMessages: [],
    }),
    searchMemories: vi.fn().mockResolvedValue({ text: "hit", total: 1, strategy: "vector" }),
    searchConversations: vi.fn().mockResolvedValue({ text: "conv", total: 3 }),
    handleSessionEnd: vi.fn().mockResolvedValue(undefined),
    getVectorStore: vi.fn().mockReturnValue({}),
    getEmbeddingService: vi.fn().mockReturnValue({}),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

type FakeCore = ReturnType<typeof makeCore>;

/** Substitutes a prepared core so no storage stack is booted. */
class TestServer extends HttpServerBase {
  readonly fakeCore: FakeCore;
  seedCalls = 0;

  constructor(opts: HttpServerBaseOptions, fakeCore: FakeCore) {
    super(opts);
    this.fakeCore = fakeCore;
  }

  protected createAdapter(): HostAdapter {
    throw new Error("not reached — initCore is overridden");
  }

  protected async initCore(): Promise<void> {
    this.core = this.fakeCore as unknown as TdaiCore;
    this.ops = new MemoryOperations(this.core, this.logger, "[test]");
  }

  protected async handleCustomRoute(
    method: string,
    pathname: string,
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    if (method === "POST" && pathname === "/seed") {
      this.seedCalls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ seeded: true }));
      return true;
    }
    return false;
  }
}

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let server: TestServer | null = null;
let baseUrl = "";
let tmpDir = "";

async function startServer(extra: Partial<HttpServerBaseOptions> = {}): Promise<TestServer> {
  const core = makeCore();
  const s = new TestServer(
    {
      dataDir: tmpDir,
      llmConfig: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      // Port 0 lets the OS pick a free port — parallel test files never collide.
      port: 0,
      host: "127.0.0.1",
      logger: silentLogger,
      ...extra,
    },
    core,
  );
  await s.start();
  const addr = s["server"]!.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  server = s;
  return s;
}

describe("HttpServerBase", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-http-test-"));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ============================
  // Auth gate
  // ============================

  describe("auth", () => {
    it("leaves routes open when no apiKey is configured", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "q", session_key: "s1" }),
      });
      expect(res.status).toBe(200);
    });

    it("rejects a request with no Authorization header", async () => {
      await startServer({ apiKey: "secret" });
      const res = await fetch(`${baseUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "q", session_key: "s1" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects a wrong bearer token", async () => {
      await startServer({ apiKey: "secret" });
      const res = await fetch(`${baseUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
        body: JSON.stringify({ query: "q", session_key: "s1" }),
      });
      expect(res.status).toBe(401);
    });

    it("accepts the correct bearer token", async () => {
      const s = await startServer({ apiKey: "secret" });
      const res = await fetch(`${baseUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({ query: "q", session_key: "s1" }),
      });
      expect(res.status).toBe(200);
      expect(s.fakeCore.handleBeforeRecall).toHaveBeenCalledWith("q", "s1");
    });

    it("keeps /health reachable without auth so probes still work", async () => {
      await startServer({ apiKey: "secret" });
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("ok");
    });
  });

  // ============================
  // Routing
  // ============================

  describe("routing", () => {
    it("dispatches each standard endpoint to its core method", async () => {
      const s = await startServer();
      const post = (p: string, body: unknown) =>
        fetch(`${baseUrl}${p}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

      expect((await post("/capture", {
        user_content: "u", assistant_content: "a", session_key: "s1",
      })).status).toBe(200);
      expect((await post("/search/memories", { query: "q" })).status).toBe(200);
      expect((await post("/search/conversations", { query: "q" })).status).toBe(200);
      expect((await post("/session/end", { session_key: "s1" })).status).toBe(200);

      expect(s.fakeCore.handleTurnCommitted).toHaveBeenCalledTimes(1);
      expect(s.fakeCore.searchMemories).toHaveBeenCalledTimes(1);
      expect(s.fakeCore.searchConversations).toHaveBeenCalledTimes(1);
      expect(s.fakeCore.handleSessionEnd).toHaveBeenCalledWith("s1");
    });

    it("returns 404 for an unknown route", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/nope`, { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("lets handleCustomRoute claim a path the base does not know", async () => {
      const s = await startServer();
      const res = await fetch(`${baseUrl}/seed`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ seeded: true });
      expect(s.seedCalls).toBe(1);
    });

    it("applies the auth gate to custom routes too", async () => {
      const s = await startServer({ apiKey: "secret" });
      const res = await fetch(`${baseUrl}/seed`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(s.seedCalls).toBe(0);
    });
  });

  // ============================
  // Error mapping
  // ============================

  describe("error mapping", () => {
    it("maps a missing required field to 400, not 500", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_key: "s1" }),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("query");
    });

    it("maps an unexpected core failure to 500", async () => {
      const s = await startServer();
      s.fakeCore.handleBeforeRecall.mockRejectedValue(new Error("store exploded"));
      const res = await fetch(`${baseUrl}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "q", session_key: "s1" }),
      });
      expect(res.status).toBe(500);
    });
  });

  // ============================
  // CORS
  // ============================

  describe("CORS", () => {
    it("sends no allow-origin header when the list is empty", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/health`, { headers: { Origin: "https://evil.test" } });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("echoes an allow-listed origin only", async () => {
      await startServer({ corsOrigins: ["https://ok.test"] });

      const allowed = await fetch(`${baseUrl}/health`, {
        headers: { Origin: "https://ok.test" },
      });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://ok.test");

      const denied = await fetch(`${baseUrl}/health`, {
        headers: { Origin: "https://evil.test" },
      });
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("answers preflight with 204", async () => {
      await startServer({ corsOrigins: ["*"] });
      const res = await fetch(`${baseUrl}/recall`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  // ============================
  // Lifecycle
  // ============================

  it("detaches its signal handlers on stop so restarts do not leak listeners", async () => {
    const before = process.listenerCount("SIGTERM");
    const s = await startServer();
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    await s.stop();
    server = null;
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
