import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { GatewayClient } from "../src/gateway-client.mjs";

const config = {
  endpoint: "http://127.0.0.1:0",
  apiKey: "local-test-key",
  serviceId: "default",
  identity: {
    teamId: "team-personal",
    agentId: "agent-personal",
    userId: "user-jin",
    taskId: "task-test"
  },
  timeouts: { recallMs: 40, captureMs: 40 },
  recall: { l0Limit: 3, l1Limit: 5, maxContextChars: 500 }
};

function readBody(request) {
  return new Promise((resolve, reject) => {
    let source = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { source += chunk; });
    request.on("end", () => resolve(JSON.parse(source)));
    request.on("error", reject);
  });
}

async function withGateway(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run({ ...config, endpoint: `http://127.0.0.1:${port}` });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("GatewayClient sends cross-session recall bodies and a prefixed write session", async () => {
  const requests = [];
  await withGateway(async (request, response) => {
    const body = await readBody(request);
    requests.push({ path: request.url, headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ code: 0, message: "ok", request_id: "req-1", data: { items: [] } }));
  }, async (clientConfig) => {
    const client = new GatewayClient(clientConfig);
    await client.searchConversation("what do I like?", 3);
    await client.searchAtomic("what do I like?", 5);
    await client.readCore();
    await client.addConversation("codex-session-1", [
      { role: "user", content: "I prefer concise answers.", timestamp: "2026-08-08T00:00:00.000Z" },
      { role: "assistant", content: "Noted.", timestamp: "2026-08-08T00:00:01.000Z" }
    ]);
  });

  assert.deepEqual(requests.map((entry) => entry.path), [
    "/v3/conversation/search",
    "/v3/atomic/search",
    "/v3/core/read",
    "/v3/conversation/add"
  ]);
  for (const entry of requests) {
    assert.equal(entry.headers.authorization, "Bearer local-test-key");
    assert.equal(entry.headers["x-tdai-service-id"], "default");
    assert.equal(entry.headers["content-type"], "application/json");
    assert.deepEqual(
      Object.fromEntries(["team_id", "agent_id", "user_id", "task_id"].map((key) => [key, entry.body[key]])),
      { team_id: "team-personal", agent_id: "agent-personal", user_id: "user-jin", task_id: "task-test" }
    );
  }
  for (const entry of requests.slice(0, 3)) assert.equal("session_id" in entry.body, false);
  assert.equal(requests[0].body.query, "what do I like?");
  assert.equal(requests[0].body.limit, 3);
  assert.equal(requests[1].body.limit, 5);
  assert.equal(requests[3].body.session_id, "codex-session-1");
  assert.equal(requests[3].body.messages.length, 2);
});

test("GatewayClient rejects unsafe transport and envelope failures without exposing its key", async () => {
  const cases = [
    { name: "HTTP failure", handler: (_request, response) => { response.statusCode = 503; response.end("unavailable"); } },
    { name: "business failure", handler: (_request, response) => response.end(JSON.stringify({ code: 7, request_id: "req-bad" })) },
    { name: "invalid JSON", handler: (_request, response) => response.end("not-json") },
    { name: "timeout", handler: () => {} }
  ];

  for (const scenario of cases) {
    await withGateway(scenario.handler, async (clientConfig) => {
      const client = new GatewayClient(clientConfig);
      await assert.rejects(
        () => client.readCore(),
        (error) => error instanceof Error && error.message.length < 200 && !error.message.includes("local-test-key")
      );
    });
  }
});

test("GatewayClient requires every field of a successful v3 envelope", async () => {
  const incompleteEnvelopes = [
    { code: 0, request_id: "req-1", data: {} },
    { code: 0, message: "ok", data: {} },
    { code: 0, message: "ok", request_id: "req-1" }
  ];

  for (const envelope of incompleteEnvelopes) {
    await withGateway((_request, response) => response.end(JSON.stringify(envelope)), async (clientConfig) => {
      await assert.rejects(
        () => new GatewayClient(clientConfig).readCore(),
        (error) => error instanceof Error && error.message.length < 200 && !error.message.includes("local-test-key")
      );
    });
  }
});

test("GatewayClient queries one explicit session for retry deduplication", async () => {
  const requests = [];
  await withGateway(async (request, response) => {
    requests.push({ path: request.url, headers: request.headers, body: await readBody(request) });
    response.end(JSON.stringify({ code: 0, message: "ok", request_id: "req-query", data: { messages: [] } }));
  }, async (clientConfig) => {
    const client = new GatewayClient(clientConfig);
    await client.queryConversation("codex-session-1", 20);
    await assert.rejects(() => client.queryConversation(""), /session/i);
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/v3/conversation/query");
  assert.equal(requests[0].headers.authorization, "Bearer local-test-key");
  assert.equal(requests[0].headers["x-tdai-service-id"], "default");
  assert.equal(requests[0].headers["content-type"], "application/json");
  assert.deepEqual(requests[0].body, {
    team_id: "team-personal",
    agent_id: "agent-personal",
    user_id: "user-jin",
    task_id: "task-test",
    session_id: "codex-session-1",
    limit: 20
  });
});

test("GatewayClient uses the capture timeout for conversation writes", async () => {
  await withGateway(async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    response.end(JSON.stringify({ code: 0, message: "ok", request_id: "req-delay", data: {} }));
  }, async (clientConfig) => {
    const client = new GatewayClient({
      ...clientConfig,
      timeouts: { recallMs: 25, captureMs: 250 }
    });
    await assert.rejects(() => client.readCore(), /timeout/);
    await client.addConversation("codex-session-1", []);
  });
});

test("GatewayClient aborts a hanging request from an external signal before its own timeout", async () => {
  await withGateway(() => {}, async (clientConfig) => {
    const controller = new AbortController();
    const client = new GatewayClient({
      ...clientConfig,
      timeouts: { recallMs: 5_000, captureMs: 5_000 }
    });
    const started = Date.now();
    const request = client.queryConversation("codex-session", 20, controller.signal);
    setTimeout(() => controller.abort(), 40);

    await assert.rejects(request, /failed|cancel|abort/i);
    assert.ok(Date.now() - started < 500);
  });
});

test("GatewayClient rejects missing or blank connection and identity configuration before a request", () => {
  const missingFields = [
    ["endpoint", (value, replacement) => { value.endpoint = replacement; }],
    ["apiKey", (value, replacement) => { value.apiKey = replacement; }],
    ["serviceId", (value, replacement) => { value.serviceId = replacement; }],
    ["teamId", (value, replacement) => { value.identity.teamId = replacement; }],
    ["agentId", (value, replacement) => { value.identity.agentId = replacement; }],
    ["userId", (value, replacement) => { value.identity.userId = replacement; }],
    ["taskId", (value, replacement) => { value.identity.taskId = replacement; }]
  ];

  for (const [field, replace] of missingFields) {
    for (const invalidValue of [undefined, " "]) {
      const invalid = structuredClone(config);
      replace(invalid, invalidValue);
      assert.throws(
        () => new GatewayClient(invalid),
        (error) => error instanceof Error && error.message.includes(field) && !error.message.includes("local-test-key")
      );
    }
  }
});
