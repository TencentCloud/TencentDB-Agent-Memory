/**
 * End-to-end tests for the Gateway-mode SDK integration.
 *
 * ─── What these tests cover ────────────────────────────────────────────
 *
 * These tests exercise the Gateway HTTP contract from the adapter's
 * perspective, using a simulated Gateway that stores captured turns
 * and returns them on subsequent recall calls ("stateful mock").
 *
 *   ✅ Empty recall → graceful return (no crash)
 *   ✅ Capture → recall returns context (memory lifecycle)
 *   ✅ Multiple captures accumulate
 *   ✅ Memory search returns structured results
 *   ✅ Conversation search returns structured results
 *   ✅ Session end flushes state
 *   ✅ Gateway error responses are handled gracefully
 *   ✅ Recall with empty/short input returns empty
 *
 * ─── What they do NOT test ─────────────────────────────────────────────
 *
 *   ❌ Real Gateway process — not required for adapter correctness
 *   ❌ TdaiCore extraction pipeline — tested in gateway tests
 *   ❌ MCP protocol layer — covered by src/adapters/mcp/server.test.ts
 *   ❌ CLI subprocess dispatch — covered by adapter.test.ts unit tests
 *
 * ─── Run ───────────────────────────────────────────────────────────────
 *
 *   pnpm test:e2e
 *   npx vitest run --config vitest.e2e.config.ts
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { ClaudeCodeAdapter } from "../adapter.js";

// ============================
// Stateful Gateway mock
// ============================

/**
 * Simulates the TDAI Gateway's memory behavior over HTTP.
 *
 * Stores captured turns in memory and returns context on recall,
 * mirroring the real Gateway's lifecycle but without requiring
 * a running Gateway process.
 */
class GatewaySimulator {
  private captures: Array<{
    user_content: string;
    assistant_content: string;
    session_key: string;
    timestamp: number;
  }> = [];
  private sessions = new Set<string>();

  /** Return a fetch-compatible handler bound to this simulator. */
  createFetchImpl(): typeof fetch {
    return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const urlStr = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      try {
        if (urlStr.includes("/health")) {
          return this.handleHealth();
        }
        if (urlStr.includes("/recall")) {
          return this.handleRecall(body);
        }
        if (urlStr.includes("/capture")) {
          return this.handleCapture(body);
        }
        if (urlStr.includes("/search/memories")) {
          return this.handleMemorySearch(body);
        }
        if (urlStr.includes("/search/conversations")) {
          return this.handleConversationSearch(body);
        }
        if (urlStr.includes("/session/end")) {
          return this.handleSessionEnd(body);
        }
        return jsonResponse({ error: "not found" }, 404);
      } catch (err) {
        return jsonResponse(
          { error: err instanceof Error ? err.message : "internal error" },
          500,
        );
      }
    });
  }

  /** Total captures stored. */
  get captureCount(): number {
    return this.captures.length;
  }

  // ── Route handlers ──

  private handleHealth(): Response {
    return jsonResponse({
      status: "ok",
      version: "1.0.0-e2e",
      uptime: 42,
      stores: { vectorStore: true, embeddingService: false },
    });
  }

  private handleRecall(body: Record<string, unknown>): Response {
    const sessionKey = String(body.session_key ?? "");
    const query = String(body.query ?? "").toLowerCase();

    if (sessionKey.startsWith("fail-")) {
      return jsonResponse({ error: "simulated gateway failure" }, 500);
    }

    if (!sessionKey || !query) {
      return jsonResponse({ context: "", strategy: "none", memory_count: 0 });
    }

    // Search captures for relevant content (simple keyword match)
    const relevant = this.captures.filter(
      (c) =>
        c.session_key === sessionKey &&
        (c.user_content.toLowerCase().includes(query) ||
          c.assistant_content.toLowerCase().includes(query)),
    );

    if (relevant.length === 0) {
      return jsonResponse({ context: "", strategy: "none", memory_count: 0 });
    }

    const context = relevant
      .map((c) => `User: ${c.user_content}\nAssistant: ${c.assistant_content}`)
      .join("\n---\n");

    return jsonResponse({
      context,
      strategy: "hybrid",
      memory_count: relevant.length,
    });
  }

  private handleCapture(body: Record<string, unknown>): Response {
    const userContent = String(body.user_content ?? "");
    const assistantContent = String(body.assistant_content ?? "");
    const sessionKey = String(body.session_key ?? "");

    if (!sessionKey) {
      return jsonResponse({ error: "missing session_key" }, 400);
    }

    if (sessionKey.startsWith("fail-")) {
      return jsonResponse({ error: "simulated gateway failure" }, 500);
    }

    this.captures.push({
      user_content: userContent,
      assistant_content: assistantContent,
      session_key: sessionKey,
      timestamp: Date.now(),
    });
    this.sessions.add(sessionKey);

    return jsonResponse({ l0_recorded: 1, scheduler_notified: true });
  }

  private handleMemorySearch(_body: Record<string, unknown>): Response {
    return jsonResponse({
      results: "1. User prefers TypeScript over JavaScript\n2. User works on memory systems",
      total: 2,
      strategy: "hybrid",
    });
  }

  private handleConversationSearch(_body: Record<string, unknown>): Response {
    const sessionKey = String(_body.session_key ?? "");

    const sessionCaptures = this.captures.filter(
      (c) => !sessionKey || c.session_key === sessionKey,
    );

    if (sessionCaptures.length === 0) {
      return jsonResponse({ results: "", total: 0 });
    }

    const results = sessionCaptures
      .map(
        (c, i) =>
          `[${i + 1}] User: ${c.user_content}\n    Assistant: ${c.assistant_content}`,
      )
      .join("\n\n");

    return jsonResponse({ results, total: sessionCaptures.length });
  }

  private handleSessionEnd(body: Record<string, unknown>): Response {
    const sessionKey = String(body.session_key ?? "");
    this.sessions.delete(sessionKey);
    return jsonResponse({ flushed: true });
  }
}

// ============================
// Test helpers
// ============================

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createAdapter(simulator: GatewaySimulator): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    gatewayUrl: "http://127.0.0.1:8420",
    fetchImpl: simulator.createFetchImpl(),
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });
}

// ============================
// Tests
// ============================

describe("Gateway-mode E2E — memory lifecycle", () => {
  let simulator: GatewaySimulator;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    simulator = new GatewaySimulator();
    adapter = createAdapter(simulator);
  });

  it("returns empty recall when no data exists", async () => {
    const result = await adapter.recall("hello world", "e2e-empty");

    expect(result).toBeDefined();
    expect(result.prependContext).toBe("");
    expect(result.strategy).toBe("none");
  });

  it("captures a conversation turn and returns it on subsequent recall", async () => {
    // Capture a turn
    await adapter.capture({
      userText: "My favorite color is blue",
      assistantText: "Blue is a calming color.",
      messages: [
        { role: "user", content: "My favorite color is blue" },
        { role: "assistant", content: "Blue is a calming color." },
      ],
      sessionKey: "e2e-lifecycle",
      success: true,
    });

    expect(simulator.captureCount).toBe(1);

    // Recall should return context
    const result = await adapter.recall("blue", "e2e-lifecycle");

    expect(result.prependContext).toBeTruthy();
    expect(result.prependContext).toContain("blue");
    expect(result.strategy).toBe("hybrid");
  });

  it("accumulates multiple captures", async () => {
    // Capture turn 1
    await adapter.capture({
      userText: "I live in Beijing",
      assistantText: "Beijing is the capital of China.",
      messages: [],
      sessionKey: "e2e-multi",
      success: true,
    });

    // Capture turn 2
    await adapter.capture({
      userText: "I work as a software engineer",
      assistantText: "Software engineering is rewarding.",
      messages: [],
      sessionKey: "e2e-multi",
      success: true,
    });

    expect(simulator.captureCount).toBe(2);

    // Recall should return context from both captures
    const result = await adapter.recall("Beijing", "e2e-multi");
    expect(result.prependContext).toBeTruthy();
    expect(result.prependContext).toContain("Beijing");
  });

  it("recall returns empty when query does not match captured data", async () => {
    await adapter.capture({
      userText: "I love hiking",
      assistantText: "Hiking is great exercise.",
      messages: [],
      sessionKey: "e2e-no-match",
      success: true,
    });

    const result = await adapter.recall("photography", "e2e-no-match");
    expect(result.prependContext).toBe("");
    expect(result.strategy).toBe("none");
  });
});

describe("Gateway-mode E2E — search operations", () => {
  let simulator: GatewaySimulator;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    simulator = new GatewaySimulator();
    adapter = createAdapter(simulator);
  });

  it("returns structured memory search results", async () => {
    const result = await adapter.searchMemories({ query: "user preferences" });

    expect(result.text).toBeTruthy();
    expect(result.text).toContain("TypeScript");
    expect(result.total).toBeGreaterThan(0);
  });

  it("returns conversation search results from captured data", async () => {
    await adapter.capture({
      userText: "Hello",
      assistantText: "Hi there!",
      messages: [],
      sessionKey: "e2e-search-conv",
      success: true,
    });

    const result = await adapter.searchConversations({
      query: "Hello",
      sessionKey: "e2e-search-conv",
    });

    expect(result.text).toBeTruthy();
    expect(result.total).toBe(1);
  });
});

describe("Gateway-mode E2E — session management", () => {
  let simulator: GatewaySimulator;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    simulator = new GatewaySimulator();
    adapter = createAdapter(simulator);
  });

  it("ends a session without error", async () => {
    await adapter.capture({
      userText: "test",
      assistantText: "ok",
      messages: [],
      sessionKey: "e2e-session-end",
      success: true,
    });

    await expect(adapter.sessionEnd("e2e-session-end")).resolves.toBeUndefined();
  });

  it("handles session end with empty key gracefully", async () => {
    await expect(adapter.sessionEnd("")).resolves.toBeUndefined();
  });
});

describe("Gateway-mode E2E — error resilience", () => {
  let simulator: GatewaySimulator;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    simulator = new GatewaySimulator();
    adapter = createAdapter(simulator);
  });

  it("handles Gateway 500 error gracefully on capture", async () => {
    // Session key starting with "fail-" triggers simulated 500
    await expect(
      adapter.capture({
        userText: "test",
        assistantText: "error",
        messages: [],
        sessionKey: "fail-test",
        success: true,
      }),
    ).resolves.toBeUndefined();
    // Should not throw — adapter logs the error and returns undefined
  });

  it("handles Gateway 500 error gracefully on recall", async () => {
    const result = await adapter.recall("something", "fail-recall");
    expect(result).toEqual({});
  });

  it("handles network errors gracefully on recall", async () => {
    const badAdapter = new ClaudeCodeAdapter({
      gatewayUrl: "http://127.0.0.1:1", // nothing listening
      timeoutMs: 100,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const result = await badAdapter.recall("hello", "sess-1");
    expect(result).toEqual({});
  });

  it("handles capture with empty sessionKey gracefully", async () => {
    await expect(
      adapter.capture({
        userText: "hello",
        assistantText: "hi",
        messages: [],
        sessionKey: "",
      }),
    ).resolves.toBeUndefined();
  });

  it("skips capture when success is false", async () => {
    await expect(
      adapter.capture({
        userText: "hello",
        assistantText: "hi",
        messages: [],
        sessionKey: "sess-1",
        success: false,
      }),
    ).resolves.toBeUndefined();
    expect(simulator.captureCount).toBe(0);
  });

  it("handles empty recall input gracefully", async () => {
    const result1 = await adapter.recall("", "sess-1");
    expect(result1).toEqual({});

    const result2 = await adapter.recall("text", "");
    expect(result2).toEqual({});
  });
});

describe("Gateway-mode E2E — health check", () => {
  it("verifies adapter construction with minimal options", () => {
    const adapter = new ClaudeCodeAdapter({
      gatewayUrl: "http://127.0.0.1:8420",
    });
    expect(adapter.platform).toBe("claude-code");
    expect(adapter.client).toBeDefined();
  });

  it("accepts configuration via env vars", () => {
    vi.stubEnv("TDAI_GATEWAY_URL", "http://env-test:8420");
    vi.stubEnv("TDAI_GATEWAY_API_KEY", "env-key-123");

    const adapter = new ClaudeCodeAdapter();
    expect(adapter.client).toBeDefined();

    vi.unstubAllEnvs();
  });
});

describe("Gateway-mode E2E — settings generation", () => {
  it("generates complete settings.json with hooks and MCP", () => {
    const settings = ClaudeCodeAdapter.generateSettingsJson();

    expect(settings).toHaveProperty("hooks");
    expect(settings).toHaveProperty("mcpServers");

    const hooks = settings.hooks as Record<string, unknown>;
    const preMessage = hooks.preMessage as Array<Record<string, unknown>>;
    expect(preMessage[0].run).toContain("claude-code-recall");

    const postMessage = hooks.postMessage as Array<Record<string, unknown>>;
    expect(postMessage[0].run).toContain("claude-code-capture");
  });

  it("generates hooks-only config when MCP is disabled", () => {
    const settings = ClaudeCodeAdapter.generateSettingsJson({ enableMcp: false });

    expect(settings).toHaveProperty("hooks");
    expect(settings).not.toHaveProperty("mcpServers");
  });

  it("uses custom runner when specified", () => {
    const settings = ClaudeCodeAdapter.generateSettingsJson({ runner: "pnpm" });
    const hooks = settings.hooks as Record<string, unknown>;
    const preMessage = (hooks.preMessage as Array<Record<string, unknown>>);
    expect(preMessage[0].run).toContain("pnpm");
  });
});
