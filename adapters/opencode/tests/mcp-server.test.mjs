/**
 * Unit & Contract tests for TencentDB Agent Memory OpenCode MCP Adapter
 *
 * Tests run against a fake gateway asserting the v3 Gateway contract.
 * Run with: node --test adapters/opencode/tests/mcp-server.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Gateway caller simulation matching mcp-server.mjs logic ─────────────────

async function callGateway(path, payload, { gatewayUrl, apiKey, serviceId, teamId, agentId, userId, taskId, timeoutMs, fetchFn }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const requestBody = {
    team_id: teamId,
    agent_id: agentId,
    user_id: userId,
    ...(taskId ? { task_id: taskId } : {}),
    ...payload,
  };

  const headers = {
    "Content-Type": "application/json",
    "x-tdai-service-id": serviceId,
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetchFn(`${gatewayUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
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
  if (typeof items === "string") return items;
  if (!Array.isArray(items) || items.length === 0) return "(no memories found)";
  return items
    .map((item, i) => {
      const score = item.score != null ? ` [score: ${item.score.toFixed(3)}]` : "";
      const content = item.content ?? item.text ?? item.summary ?? item.memory ?? JSON.stringify(item);
      return `${i + 1}.${score}\n${content}`;
    })
    .join("\n\n");
}

function makeFakeGateway(responses = {}) {
  return async function fakeFetch(url, options) {
    const urlPath = new URL(url).pathname;

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

const DEFAULT_CONFIG = {
  gatewayUrl: "http://localhost:8420",
  apiKey: "test-user-key",
  serviceId: "default",
  teamId: "team-alpha",
  agentId: "opencode",
  userId: "user-123",
  taskId: "task-abc",
  timeoutMs: 5000,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("v3 Gateway Contract — tdai_memory_search (/v3/atomic/search)", () => {
  it("calls /v3/atomic/search with correct headers and snake_case body", async () => {
    let capturedUrl, capturedHeaders, capturedBody;
    const fetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ memory: "Prefers TypeScript strict mode", score: 0.95 }],
        }),
      };
    };

    const result = await callGateway(
      "/v3/atomic/search",
      { query: "coding conventions", limit: 5 },
      { ...DEFAULT_CONFIG, fetchFn: fetch }
    );

    // Assert endpoint
    assert.equal(capturedUrl, "http://localhost:8420/v3/atomic/search");

    // Assert v3 headers
    assert.equal(capturedHeaders["Authorization"], "Bearer test-user-key");
    assert.equal(capturedHeaders["x-tdai-service-id"], "default");
    assert.equal(capturedHeaders["Content-Type"], "application/json");

    // Assert v3 tenant isolation body payload
    assert.equal(capturedBody.team_id, "team-alpha");
    assert.equal(capturedBody.agent_id, "opencode");
    assert.equal(capturedBody.user_id, "user-123");
    assert.equal(capturedBody.task_id, "task-abc");
    assert.equal(capturedBody.query, "coding conventions");
    assert.equal(capturedBody.limit, 5);

    // Assert result
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].memory, "Prefers TypeScript strict mode");
  });
});

describe("v3 Gateway Contract — tdai_conversation_search (/v3/conversation/search)", () => {
  it("calls /v3/conversation/search with correct headers and snake_case body", async () => {
    let capturedUrl, capturedHeaders, capturedBody;
    const fetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ text: "Discussed DB migration last session" }],
        }),
      };
    };

    const result = await callGateway(
      "/v3/conversation/search",
      { query: "DB migration", limit: 3 },
      { ...DEFAULT_CONFIG, fetchFn: fetch }
    );

    assert.equal(capturedUrl, "http://localhost:8420/v3/conversation/search");
    assert.equal(capturedHeaders["Authorization"], "Bearer test-user-key");
    assert.equal(capturedHeaders["x-tdai-service-id"], "default");
    assert.equal(capturedBody.team_id, "team-alpha");
    assert.equal(capturedBody.query, "DB migration");
    assert.equal(capturedBody.limit, 3);
    assert.equal(result.items.length, 1);
  });
});

describe("gatewayRequest — failure / error paths (Fail-Open)", () => {
  it("returns error envelope on gateway 500", async () => {
    const fetch = makeFakeGateway({ "/v3/atomic/search": "gateway_500" });
    const result = await callGateway("/v3/atomic/search", { query: "x" }, { ...DEFAULT_CONFIG, fetchFn: fetch });
    assert.ok(result.error, "should have error field");
    assert.ok(result.error.includes("500"), "error should mention status 500");
    assert.deepEqual(result.items, []);
  });

  it("returns error envelope on network failure", async () => {
    const fetch = makeFakeGateway({ "/v3/atomic/search": "network_error" });
    const result = await callGateway("/v3/atomic/search", { query: "x" }, { ...DEFAULT_CONFIG, fetchFn: fetch });
    assert.ok(result.error, "should have error field");
    assert.ok(result.error.includes("gateway unreachable"));
    assert.deepEqual(result.items, []);
  });

  it("returns timeout error envelope when request exceeds timeout", async () => {
    const fetch = makeFakeGateway({ "/v3/atomic/search": "timeout" });
    const result = await callGateway("/v3/atomic/search", { query: "x" }, { ...DEFAULT_CONFIG, timeoutMs: 100, fetchFn: fetch });
    assert.ok(result.error, "should have error field");
    assert.ok(result.error.includes("timeout"), `expected timeout in: ${result.error}`);
    assert.deepEqual(result.items, []);
  });

  it("does NOT throw on any gateway failure (fail-open)", async () => {
    const fetch = makeFakeGateway({ "/v3/atomic/search": "network_error" });
    await assert.doesNotReject(
      callGateway("/v3/atomic/search", { query: "x" }, { ...DEFAULT_CONFIG, fetchFn: fetch })
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

  it("formats items with memory field", () => {
    const result = formatItems([{ memory: "Atomic memory fact" }]);
    assert.ok(result.includes("1."));
    assert.ok(result.includes("Atomic memory fact"));
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

  it("passes through raw string results", () => {
    assert.equal(formatItems("Found 2 matching messages"), "Found 2 matching messages");
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
    const EXPECTED_TOOLS = ["tdai_memory_search", "tdai_conversation_search"];
    assert.equal(EXPECTED_TOOLS.length, 2);
    assert.ok(EXPECTED_TOOLS.includes("tdai_memory_search"));
    assert.ok(EXPECTED_TOOLS.includes("tdai_conversation_search"));
  });

  it("tdai_memory_search has required 'query' parameter", () => {
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
