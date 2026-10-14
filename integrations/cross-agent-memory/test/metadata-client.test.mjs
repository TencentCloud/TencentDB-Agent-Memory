import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

import { MetadataClient } from "../src/metadata-client.mjs";

async function requestBody(request) {
  let source = "";
  request.setEncoding("utf8");
  for await (const chunk of request) source += chunk;
  return JSON.parse(source);
}

function envelope(data, requestId = "req-1") {
  return { code: 0, message: "ok", request_id: requestId, data };
}

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

test("metadata client rejects a structurally incomplete successful envelope", async () => {
  await withServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: 0, data: { valid: true, user: { user_id: "usr-1" } } }));
  }, async (endpoint) => {
    const client = new MetadataClient({ endpoint, apiKey: "gateway-token", serviceId: "default", userKey: "admin-user-key" });
    await assert.rejects(client.verifyCurrentUser(), /invalid metadata api response/i);
  });
});

test("metadata client retrieves every page from a complete real list envelope", async () => {
  const bodies = [];
  const allTeams = Array.from({ length: 101 }, (_, index) => ({
    team_id: `team-${index + 1}`,
    name: "个人跨 Agent 记忆",
    owner_user_id: "usr-1",
    status: "active"
  }));
  await withServer(async (request, response) => {
    const body = await requestBody(request);
    bodies.push(body);
    const items = allTeams.slice(body.offset, body.offset + body.limit);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(envelope({
      items,
      total: allTeams.length,
      limit: body.limit,
      offset: body.offset
    })));
  }, async (endpoint) => {
    const client = new MetadataClient({ endpoint, apiKey: "gateway-token", serviceId: "default", userKey: "admin-user-key" });
    const teams = await client.listTeams({ userId: "usr-1", name: "个人跨 Agent 记忆" });
    assert.deepEqual(teams, allTeams);
  });
  assert.deepEqual(bodies, [
    { user_id: "usr-1", name: "个人跨 Agent 记忆", limit: 100, offset: 0 },
    { user_id: "usr-1", name: "个人跨 Agent 记忆", limit: 100, offset: 100 }
  ]);
});

test("every metadata list endpoint sends max-100 pagination and accepts only the complete page shape", async () => {
  const requests = [];
  await withServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ path: request.url, body });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(envelope({ items: [], total: 0, limit: body.limit, offset: body.offset })));
  }, async (endpoint) => {
    const client = new MetadataClient({ endpoint, apiKey: "gateway-token", serviceId: "default", userKey: "admin-user-key" });
    await client.listAgents({ teamId: "team-1", name: "共享个人助手" });
    await client.listTasks({ teamId: "team-1", title: "日常共享对话" });
    await client.listTaskAgents({ taskId: "task-1" });
    await client.listChatMemoryAssets({ teamId: "team-1", agentId: "agt-1" });
  });
  assert.deepEqual(requests.map(({ path }) => path), [
    "/v3/meta/agent/list",
    "/v3/meta/task/list",
    "/v3/meta/task-agent/list",
    "/v3/meta/asset/list"
  ]);
  assert.deepEqual(requests.map(({ body }) => [body.limit, body.offset]), [
    [100, 0], [100, 0], [100, 0], [100, 0]
  ]);
});

for (const [label, pages] of [
  ["missing pagination fields", [{ items: [] }]],
  ["truncated first page", [{ items: [{ team_id: "team-1" }], total: 2, limit: 100, offset: 0 }]],
  ["mismatched offset", [{ items: [], total: 0, limit: 100, offset: 1 }]],
  ["no progress before total", [
    { items: Array.from({ length: 100 }, (_, index) => ({ team_id: `team-${index}` })), total: 101, limit: 100, offset: 0 },
    { items: [], total: 101, limit: 100, offset: 100 }
  ]]
]) {
  test(`metadata list fails closed on ${label}`, async () => {
    let call = 0;
    await withServer(async (_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(envelope(pages[Math.min(call++, pages.length - 1)])));
    }, async (endpoint) => {
      const client = new MetadataClient({ endpoint, apiKey: "gateway-token", serviceId: "default", userKey: "admin-user-key" });
      await assert.rejects(client.listTeams({ userId: "usr-1", name: "个人跨 Agent 记忆" }), /invalid metadata api list response/i);
    });
  });
}

test("metadata client explicitly creates the official agent with team visibility", async () => {
  let body;
  await withServer(async (request, response) => {
    body = await requestBody(request);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(envelope({
      agent_id: "agt-1",
      team_id: "team-1",
      owner_user_id: "usr-1",
      name: "共享个人助手",
      visibility: "team",
      status: "active"
    })));
  }, async (endpoint) => {
    const client = new MetadataClient({ endpoint, apiKey: "gateway-token", serviceId: "default", userKey: "admin-user-key" });
    await client.createAgent({ teamId: "team-1", ownerUserId: "usr-1", name: "共享个人助手", visibility: "team" });
  });
  assert.deepEqual(body, {
    team_id: "team-1",
    owner_user_id: "usr-1",
    name: "共享个人助手",
    visibility: "team"
  });
});

test("metadata client aborts a hanging fetch within its finite timeout without exposing credentials", async () => {
  const secret = "metadata-admin-secret";
  await withServer(() => {}, async (endpoint) => {
    const client = new MetadataClient({
      endpoint,
      apiKey: "metadata-gateway-secret",
      serviceId: "default",
      userKey: secret,
      timeoutMs: 30
    });
    await assert.rejects(
      Promise.race([
        client.verifyCurrentUser(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("client did not abort")), 200))
      ]),
      (error) => /metadata api unavailable/i.test(error.message) && !error.message.includes(secret)
    );
  });
});
