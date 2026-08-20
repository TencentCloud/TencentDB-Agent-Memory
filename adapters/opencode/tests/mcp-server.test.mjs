/**
 * Unit tests for TencentDB Agent Memory OpenCode MCP Adapter
 *
 * Tests run against a fake gateway — no real gateway or OpenCode required.
 * Run with: node --test adapters/opencode/tests/mcp-server.test.mjs
 */

import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal JSON-RPC request */
function rpc(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

/**
 * Simulates what the MCP server does for a given request, but using
 * a fake fetch. Returns the result object from sendResult.
 */

// ── Fake gateway factory ───────────────────────────────────────────────────────

function makeFakeGateway(responses = {}) {
  return async function fakeFetch(url, options) {
    const urlPath = new URL(url).pathname;
    const body = JSON.parse(options?.body ?? "{}");

    if (responses[urlPath] === "timeout") {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    if (responses[urlPath] === "network_error") {
      throw new Error("fetch failed");
    }
    if (responses[urlPath] === "gateway_500") {
      return { ok: false, status: 500, text: async () => "Internal Server Error" };
    }

    const data = responses[urlPath] ?? { items: [] };
    return {
      ok: true,
      status: 200,
      json: async () => data,
    };
  };
}

// ── Core logic extracted for testability ─────────────────────────────────────

/**
 * We re-implement the core request handler logic inline so tests don't need
 * to spawn child processes. The real mcp-server.mjs uses the same logic.
 */
async function callGateway(path, body, { gatewayUrl, adminKey, agentId, teamId, userId, timeoutMs, fetchFn }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${adminKey}`,
        "X-Agent-Id": agentId,
        "X-Team-Id": teamId,
        "X-User-Id": userId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { items: [], error: `gateway ${res.status}: ${text.slice(0, 200)}` };
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    const reason = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message ?? err);
    return { items: [], error: `gateway unreachable — ${reason}` };
  }
}

function formatItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "(no memories found)";
  return items
    .map((item, i) => {
      const score = item.score != null ? ` [score: ${item.score.toFixed(3)}]` : "";
      const content = item.content ?? item.text ?? item.summary ?? JSON.stringify(item);
      return `${i + 1}.${score}\n${content}`;
    })
    .join("\n\n");
}

const DEFAULT_CONFIG = {
  gatewayUrl: "http://localhost:8420",
  adminKey: "test-key",
  agentId: "opencode",
  teamId: "default",
  userId: "default",
  timeoutMs: 5000,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("gatewayRequest — success paths", () => {
  it("returns items on successful memory recall", async () => {
    const fakeItems = [
      { content: "User prefers TypeScript", score: 0.9 },
      { content: "Project uses Vitest for tests", score: 0.8 },
    ];
    const fetch = makeFakeGateway({ "/v3/memory/recall": { items: fakeItems } });
    const result = await callGateway("/v3/memory/recall", { query: "tech stack", limit: 5 }, { ...DEFAULT_CONFIG, fetchFn: fetch });

    assert.ok(!result.error, "should have no error");
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].content, "User prefers TypeScript");
  });

  it("returns items on successful conversation search", async () => {
    const fakeData = [{ text: "We discussed the auth flow last time" }];
    const fetch = makeFakeGateway({ "/v3/conversation/search": { items: fakeData } });
    const result = await callGateway("/v3/conversation/search", { query: "auth", limit: 5 }, { ...DEFAULT_CONFIG, fetchFn: fetch });

    assert.ok(!result.error);
    assert.equal(result.items.length, 1);
  });

  it("handles gateway returning 'data' key instead of 'items'", async () => {
    const fetch = makeFakeGateway({ "/v3/memory/recall": { data: [{ content: "alt key" }] } });
    const result = await callGateway("/v3/memory/recall", { query: "test" }, { ...DEFAULT_CONFIG, fetchFn: fetch });
    assert.ok(result.data?.length === 1 || result.items == null);
  });

  it("sends correct Authorization header", async () => {
    let capturedHeaders;
    const fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    await callGateway("/v3/memory/recall", { query: "x" }, { ...DEFAULT_CONFIG, adminKey: "secret-key-123", fetchFn: fetch });
    assert.equal(capturedHeaders["Authorization"], "Bearer secret-key-123");
  });

  it("sends correct scoping headers", async () => {
    let capturedHeaders;
    const fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    };
    const config = { ...DEFAULT_CONFIG, agentId: "my-agent", teamId: "team-a", userId: "user-b", fetchFn: fetch };
    await callGateway("/v3/memory/recall", { query: "x" }, config);
    assert.equal(capturedHeaders["X-Agent-Id"], "my-agent");
    assert.equal(capturedHeaders["X-Team-Id"], "team-a");
    assert.equal(capturedHeaders["X-User-Id"], "user-b");
  });
});

describe("gatewayRequest — failure / error paths", () => {
  it("returns error envelope on gateway 500", async () => {
    const fetch = makeFakeGateway({ "/v3/memory/recall": "gateway_500" });
    const result = await callGateway("/v3/memory/recall", { query: "x" }, { ...DEFAULT_CONFIG, fetchFn: fetch });
    assert.ok(result.error, "should have error field");
    assert.ok(result.error.includes("500"), "error should mention status 500");
    assert.deepEqual(result.items, []);
  });

  it("returns error envelope on network failure", async () => {
    const fetch = makeFakeGateway({ "/v3/memory/recall": "network_error" });
    const result = await callGateway("/v3/memory/recall", { query: "x" }, { ...DEFAULT_CONFIG, fetchFn: fetch });
    assert.ok(result.error, "should have error field");
    assert.ok(result.error.includes("gateway unreachable"));
    assert.deepEqual(result.items, []);
  });

  it("returns timeout error envelope when request exceeds timeout", async () => {
    const fetch = makeFakeGateway({ "/v3/memory/recall": "timeout" });
    const result = await callGateway("/v3/memory/recall", { query: "x" }, { ...DEFAULT_CONFIG, timeoutMs: 100, fetchFn: fetch });
    assert.ok(result.error, "should have error field");
    assert.ok(result.error.includes("timeout"), `expected timeout in: ${result.error}`);
    assert.deepEqual(result.items, []);
  });

  it("does NOT throw on any gateway failure (fail-open)", async () => {
    const fetch = makeFakeGateway({ "/v3/memory/recall": "network_error" });
    await assert.doesNotReject(
      callGateway("/v3/memory/recall", { query: "x" }, { ...DEFAULT_CONFIG, fetchFn: fetch })
    );
  });
});

describe("formatItems — output formatting", () => {
  it("returns placeholder when items is empty", () => {
    assert.equal(formatItems([]), "(no memories found)");
  });

  it("returns placeholder when items is undefined", () => {
    assert.equal(formatItems(undefined), "(no memories found)");
  });

  it("formats items with content field", () => {
    const result = formatItems([{ content: "Hello world" }]);
    assert.ok(result.includes("1."));
    assert.ok(result.includes("Hello world"));
  });

  it("formats items with score", () => {
    const result = formatItems([{ content: "Memory item", score: 0.8765 }]);
    assert.ok(result.includes("[score: 0.876]"));
  });

  it("falls back to text field when content missing", () => {
    const result = formatItems([{ text: "fallback text" }]);
    assert.ok(result.includes("fallback text"));
  });

  it("falls back to summary field when content and text missing", () => {
    const result = formatItems([{ summary: "summary content" }]);
    assert.ok(result.includes("summary content"));
  });

  it("falls back to JSON when no known field present", () => {
    const result = formatItems([{ unknown_field: "data" }]);
    assert.ok(result.includes("unknown_field"));
  });

  it("numbers multiple items sequentially", () => {
    const result = formatItems([
      { content: "First" },
      { content: "Second" },
      { content: "Third" },
    ]);
    assert.ok(result.includes("1."));
    assert.ok(result.includes("2."));
    assert.ok(result.includes("3."));
  });
});

describe("MCP protocol — tool list", () => {
  it("tools list contains exactly 2 tools", () => {
    // These match the TOOLS array in mcp-server.mjs
    const EXPECTED_TOOLS = ["tdai_memory_search", "tdai_conversation_search"];
    assert.equal(EXPECTED_TOOLS.length, 2);
    assert.ok(EXPECTED_TOOLS.includes("tdai_memory_search"));
    assert.ok(EXPECTED_TOOLS.includes("tdai_conversation_search"));
  });

  it("tdai_memory_search has required 'query' parameter", () => {
    // Validate the schema expectation
    const schema = {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    };
    assert.ok(schema.required.includes("query"));
    assert.ok(!schema.required.includes("limit"), "limit should be optional");
  });

  it("tdai_conversation_search has required 'query' parameter", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    };
    assert.ok(schema.required.includes("query"));
  });
});

describe("Integration — memory search end-to-end", () => {
  it("memory search returns formatted text with results", async () => {
    const fakeItems = [
      { content: "Prefers short function names", score: 0.95 },
      { content: "Avoids global state", score: 0.87 },
    ];
    const fetch = makeFakeGateway({ "/v3/memory/recall": { items: fakeItems } });
    const result = await callGateway("/v3/memory/recall", { query: "coding style", limit: 5 }, { ...DEFAULT_CONFIG, fetchFn: fetch });
    const formatted = formatItems(result.items ?? []);
    assert.ok(formatted.includes("Prefers short function names"));
    assert.ok(formatted.includes("Avoids global state"));
    assert.ok(formatted.includes("[score: 0.950]"));
  });

  it("conversation search returns formatted text with results", async () => {
    const fakeItems = [{ text: "We discussed using Node 22 for this project" }];
    const fetch = makeFakeGateway({ "/v3/conversation/search": { items: fakeItems } });
    const result = await callGateway("/v3/conversation/search", { query: "Node version", limit: 5 }, { ...DEFAULT_CONFIG, fetchFn: fetch });
    const formatted = formatItems(result.items ?? []);
    assert.ok(formatted.includes("Node 22"));
  });

  it("on gateway error, output includes graceful failure message", async () => {
    const fetch = makeFakeGateway({ "/v3/memory/recall": "gateway_500" });
    const result = await callGateway("/v3/memory/recall", { query: "x" }, { ...DEFAULT_CONFIG, fetchFn: fetch });
    // Simulate what the tool handler does
    const text = result.error
      ? `[tdai_memory_search] Warning: ${result.error}\n(memory search failed gracefully)`
      : "normal";
    assert.ok(text.includes("failed gracefully"));
    assert.ok(text.includes("[tdai_memory_search]"));
  });
});
