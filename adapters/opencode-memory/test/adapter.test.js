/**
 * Zero-dependency smoke tests for the OpenCode adapter.
 *
 * Runs with the Node built-in test runner against a real local HTTP server that
 * mocks the Memory Gateway, so no packages need to be installed:
 *
 *   node --test test/
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  createMemoryPlugin,
  formatSearchResults,
  loadConfig,
  transcriptFromMessages,
} from "../src/index.js";

/** Spin up an in-process mock of the Memory Gateway. */
async function startGateway(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      handler({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : {} })
        .then(([status, payload]) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        })
        .catch((error) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 500, message: error.message }));
        });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const env = {
  OPCODE_MEMORY_GATEWAY_URL: "http://127.0.0.1:1", // replaced per test
  OPCODE_MEMORY_API_KEY: "test-key",
  OPCODE_MEMORY_TEAM_ID: "team-x",
  OPCODE_MEMORY_AGENT_ID: "agent-y",
  OPCODE_MEMORY_SERVICE_ID: "svc-a",
  OPCODE_MEMORY_USER_ID: "user-z",
  OPCODE_MEMORY_TIMEOUT_MS: "2000",
};

test("loadConfig applies defaults and overrides", () => {
  const cfg = loadConfig({ ...env, OPCODE_MEMORY_GATEWAY_URL: "http://127.0.0.1:9999" });
  assert.equal(cfg.gatewayUrl, "http://127.0.0.1:9999");
  assert.equal(cfg.apiKey, "test-key");
  assert.equal(cfg.timeoutMs, 2000);

  const fallback = loadConfig({});
  assert.equal(fallback.gatewayUrl, "http://127.0.0.1:8420");
  assert.equal(fallback.timeoutMs, 10_000);
});

test("transcriptFromMessages extracts user/assistant text and drops the rest", () => {
  const messages = [
    { info: { role: "user", id: "m1" }, parts: [{ type: "text", text: "分析招商银行中报" }] },
    { info: { role: "assistant", id: "m2" }, parts: [{ type: "text", text: "净息差 1.98%" }, { type: "tool", name: "bash" }] },
    { info: { role: "user" }, parts: [] },
    { info: { role: "system", id: "m4" }, parts: [{ type: "text", text: "ignored" }] },
    { info: { role: "assistant", id: "m5" }, parts: [{ type: "text", text: "  " }] },
  ];
  const transcript = transcriptFromMessages(messages);
  assert.deepEqual(
    transcript.map(({ role, content }) => ({ role, content })),
    [
      { role: "user", content: "分析招商银行中报" },
      { role: "assistant", content: "净息差 1.98%" },
    ],
  );
});

test("formatSearchResults renders items and truncates long output", () => {
  const out = formatSearchResults(
    [
      { content: "净息差 1.98%", score: 0.9123 },
      { content: "不良率 1.25%" },
      "plain hit",
    ],
    100,
  );
  assert.match(out, /1\. \[score=0\.912\] 净息差 1\.98%/);
  assert.match(out, /3\. plain hit/);

  const empty = formatSearchResults([]);
  assert.equal(empty, "No memories found.");

  const truncated = formatSearchResults("x".repeat(200), 50);
  assert.equal(truncated.length, 50 + "\n… (truncated)".length);
  assert.match(truncated, /truncated/);
});

test("session.idle persists the transcript via /v3/conversation/add", async () => {
  const calls = [];
  const server = await startGateway(async (req) => {
    calls.push(req);
    if (req.url === "/v3/conversation/add") {
      return [200, { code: 0, message: "ok", data: { conversation_id: "c-1" } }];
    }
    return [404, { code: 404, message: "not found" }];
  });
  const { port } = server.address();
  try {
    const ctx = {
      client: {
        session: {
          messages: async () => ({
            data: [
              { info: { role: "user", id: "m1" }, parts: [{ type: "text", text: "你好" }] },
              { info: { role: "assistant", id: "m2" }, parts: [{ type: "text", text: "你好，有什么可以帮你？" }] },
            ],
          }),
        },
      },
    };
    const plugin = createMemoryPlugin(ctx, { ...env, OPCODE_MEMORY_GATEWAY_URL: `http://127.0.0.1:${port}` });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_123" } } });

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/v3/conversation/add");
    assert.equal(call.headers["x-tdai-service-id"], "svc-a");
    assert.equal(call.headers.authorization, "Bearer test-key");
    assert.equal(call.body.team_id, "team-x");
    assert.equal(call.body.session_id, "ses_123");
    assert.deepEqual(
      call.body.messages.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "你好" },
        { role: "assistant", content: "你好，有什么可以帮你？" },
      ],
    );
  } finally {
    server.close();
  }
});

test("session.idle does not double-capture the same turn", async () => {
  let addCalls = 0;
  const server = await startGateway(async (req) => {
    if (req.url === "/v3/conversation/add") {
      addCalls += 1;
      return [200, { code: 0, data: {} }];
    }
    return [404, { code: 404, message: "not found" }];
  });
  const { port } = server.address();
  try {
    const ctx = {
      client: {
        session: {
          messages: async () => ({
            data: [{ info: { role: "user", id: "m1" }, parts: [{ type: "text", text: "hi" }] }],
          }),
        },
      },
    };
    const plugin = createMemoryPlugin(ctx, { ...env, OPCODE_MEMORY_GATEWAY_URL: `http://127.0.0.1:${port}` });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_dup" } } });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_dup" } } });
    assert.equal(addCalls, 1);
  } finally {
    server.close();
  }
});

test("capture retries once on transient gateway failure", async () => {
  let attempts = 0;
  const server = await startGateway(async (req) => {
    attempts += 1;
    if (attempts === 1) return [503, { code: 503, message: "temporarily unavailable" }];
    return [200, { code: 0, data: {} }];
  });
  const { port } = server.address();
  try {
    const ctx = {
      client: {
        session: {
          messages: async () => ({
            data: [{ info: { role: "user", id: "m1" }, parts: [{ type: "text", text: "hi" }] }],
          }),
        },
      },
    };
    const plugin = createMemoryPlugin(ctx, { ...env, OPCODE_MEMORY_GATEWAY_URL: `http://127.0.0.1:${port}` });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_retry" } } });
    assert.equal(attempts, 2);
  } finally {
    server.close();
  }
});

test("memory_search tool calls /v3/atomic/search and formats results", async () => {
  const server = await startGateway(async (req) => {
    if (req.url === "/v3/atomic/search") {
      return [200, { code: 0, data: [{ content: "净息差 1.98%", score: 0.9 }] }];
    }
    return [404, { code: 404, message: "not found" }];
  });
  const { port } = server.address();
  try {
    const plugin = createMemoryPlugin({ client: {} }, { ...env, OPCODE_MEMORY_GATEWAY_URL: `http://127.0.0.1:${port}` });
    const output = await plugin.tool.memory_search.execute({ query: "招商银行 净息差", limit: 3 });
    assert.match(output, /净息差 1\.98%/);
    assert.match(output, /score=0\.900/);
  } finally {
    server.close();
  }
});

test("gateway rejects a non-zero v3 envelope code", async () => {
  const server = await startGateway(async () => [200, { code: 5001, message: "backend exploded" }]);
  const { port } = server.address();
  try {
    const plugin = createMemoryPlugin({ client: {} }, { ...env, OPCODE_MEMORY_GATEWAY_URL: `http://127.0.0.1:${port}` });
    await assert.rejects(plugin.tool.memory_search.execute({ query: "x" }), /5001: backend exploded/);
  } finally {
    server.close();
  }
});

test("capture is skipped (not corrupted) when the transcript cannot be read", async () => {
  let addCalls = 0;
  const server = await startGateway(async (req) => {
    addCalls += 1;
    return [200, { code: 0, data: {} }];
  });
  const { port } = server.address();
  try {
    const ctx = {
      client: {
        session: {
          messages: async () => {
            throw new Error("session not found");
          },
        },
      },
    };
    const plugin = createMemoryPlugin(ctx, { ...env, OPCODE_MEMORY_GATEWAY_URL: `http://127.0.0.1:${port}` });
    await plugin.event({ event: { type: "session.idle", properties: { sessionID: "ses_gone" } } });
    assert.equal(addCalls, 0);
  } finally {
    server.close();
  }
});
