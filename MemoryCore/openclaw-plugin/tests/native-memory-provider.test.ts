import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import register from "../index.ts";
import { createNativeMemoryProviderRuntime } from "../src/native-memory-provider.ts";

type JsonRequest = { path: string; body: Record<string, unknown> };
type RegisteredMemoryCapability = {
  providerRuntime?: {
    open(params: {
      cfg: Record<string, unknown>;
      agentId: string;
      context: {
        authority: Record<string, unknown>;
        assertCurrent(): void;
        signal?: AbortSignal;
      };
      purpose?: "default" | "status" | "cli";
    }): Promise<{ provider: any; error?: string }>;
    closeAllMemorySearchManagers(): Promise<void>;
  };
};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, data: unknown) {
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: 0, data }));
}

test("plugin entrypoint registers and exercises a caller-scoped native provider", async (t) => {
  const requests: JsonRequest[] = [];
  let slowRequestCount = 0;
  const slowWaiters = new Map<number, () => void>();
  const waitForSlowRequest = (count: number) => new Promise<void>((resolve) => {
    if (slowRequestCount >= count) resolve();
    else slowWaiters.set(count, resolve);
  });
  const server = createServer(async (request, response) => {
    const body = await readJson(request);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push({ path, body });
    if (body.query === "slow") {
      slowRequestCount += 1;
      slowWaiters.get(slowRequestCount)?.();
      setTimeout(() => sendJson(response, {
        items: [{ id: "late-memory", type: "fact", content: "late", score: 0.5 }],
      }), 2_000);
      return;
    }
    if (path.endsWith("/atomic/search")) {
      sendJson(response, {
        items: [{ id: "memory-1", type: "preference", content: "likes tea", score: 0.9 }],
      });
      return;
    }
    if (path.endsWith("/conversation/search")) {
      sendJson(response, {
        messages: [{
          id: "message-1",
          role: "user",
          content: "Tea is my favorite.",
          timestamp: "2026-10-23T00:00:00.000Z",
          score: 0.8,
        }],
      });
      return;
    }
    if (path.endsWith("/atomic/count")) {
      sendJson(response, { total: 1 });
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  let capability: RegisteredMemoryCapability | undefined;
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  const api = {
    id: "memory-tencentdb-client",
    pluginConfig: {
      server: {
        url: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key",
        instanceId: "test-instance",
        teamId: "team-1",
        agentId: "gateway-agent-1",
        userId: "user-1",
      },
    },
    logger,
    registerMemoryCapability(value: RegisteredMemoryCapability) {
      capability = value;
    },
    registerTool() {},
    on() {},
  };

  register(api);
  const runtime = capability?.providerRuntime;
  assert.ok(runtime, "the real plugin entrypoint must register providerRuntime");

  const authority = {
    kind: "session",
    sessionKey: "openclaw/session-key",
    sessionId: "gateway-session-1",
    sandboxed: false,
    audience: {
      kind: "conversation",
      agentId: "openclaw-agent-1",
      sessionKey: "openclaw/session-key",
      sessionId: "gateway-session-1",
    },
  };
  const opened = await runtime.open({
    cfg: {},
    agentId: "openclaw-agent-1",
    context: { authority, assertCurrent() {} },
  });
  assert.ok(opened.provider, opened.error);
  const provider = opened.provider;

  const page = await provider.search({ query: "tea", maxResults: 5 });
  assert.deepEqual(page.hits.map((hit: any) => hit.source), ["memory", "sessions"]);
  assert.deepEqual(provider.capabilities.sources, ["memory", "sessions"]);
  const atomicHit = page.hits.find((hit: any) => hit.source === "memory");
  const sessionHit = page.hits.find((hit: any) => hit.source === "sessions");
  assert.ok(atomicHit && sessionHit);

  const memory = await provider.get({ reference: atomicHit.reference });
  const conversation = await provider.get({ reference: sessionHit.reference });
  assert.equal(memory.status, "ok");
  assert.equal(memory.text, "likes tea");
  assert.equal(conversation.status, "ok");
  assert.equal(conversation.text, "Tea is my favorite.");
  assert.equal((await provider.health()).status, "ready");

  const scopedRequests = requests.filter((request) =>
    request.path.endsWith("/atomic/search") || request.path.endsWith("/conversation/search"),
  );
  assert.ok(scopedRequests.length >= 4, "search and get should each reach the v3 API");
  for (const request of scopedRequests) {
    assert.equal(request.body.team_id, "team-1");
    assert.equal(request.body.agent_id, "openclaw-agent-1");
    assert.equal(request.body.user_id, "user-1");
    assert.equal(request.body.session_id, "gateway-session-1");
  }

  const secondAgentAuthority = {
    ...authority,
    sessionKey: "openclaw/second-agent-key",
    sessionId: "gateway-session-2",
    audience: {
      kind: "conversation",
      agentId: "openclaw-agent-2",
      sessionKey: "openclaw/second-agent-key",
      sessionId: "gateway-session-2",
    },
  };
  const secondAgent = await runtime.open({
    cfg: {},
    agentId: "openclaw-agent-2",
    context: { authority: secondAgentAuthority, assertCurrent() {} },
  });
  assert.ok(secondAgent.provider, secondAgent.error);
  await secondAgent.provider.search({ query: "tea", sources: ["memory"] });
  const secondAgentRequest = requests.find((request) =>
    request.body.session_id === "gateway-session-2" &&
    request.path.endsWith("/atomic/search"),
  );
  assert.equal(secondAgentRequest?.body.agent_id, "openclaw-agent-2");
  await secondAgent.provider.close();

  const cancelledController = new AbortController();
  const cancellable = await runtime.open({
    cfg: {},
    agentId: "openclaw-agent-1",
    context: { authority, assertCurrent() {}, signal: cancelledController.signal },
  });
  assert.ok(cancellable.provider);
  const cancelledSearch = cancellable.provider.search({ query: "slow", sources: ["memory"] });
  await waitForSlowRequest(1);
  cancelledController.abort(new Error("caller cancelled"));
  await assert.rejects(cancelledSearch, /caller cancelled/);
  await cancellable.provider.close();

  const closeController = new AbortController();
  const closable = await runtime.open({
    cfg: {},
    agentId: "openclaw-agent-1",
    context: { authority, assertCurrent() {}, signal: closeController.signal },
  });
  assert.ok(closable.provider);
  const closingSearch = closable.provider.search({ query: "slow", sources: ["memory"] });
  await waitForSlowRequest(2);
  await closable.provider.close();
  await assert.rejects(closingSearch, /closed/);
  await assert.rejects(
    closable.provider.search({ query: "tea", sources: ["memory"] }),
    /closed/,
  );

  await provider.close();
  await assert.rejects(
    provider.get({ reference: atomicHit.reference }),
    /closed/,
  );

  capability = undefined;
  register(api);
  const reloadedRuntime = capability?.providerRuntime;
  assert.ok(reloadedRuntime, "a reloaded plugin must register its provider runtime again");
  const reopened = await reloadedRuntime.open({
    cfg: {},
    agentId: "openclaw-agent-1",
    context: { authority, assertCurrent() {} },
  });
  assert.ok(reopened.provider, reopened.error);
  assert.equal(
    (await reopened.provider.get({ reference: atomicHit.reference })).status,
    "not_found",
  );
  const readbackPage = await reopened.provider.search({ query: "tea", sources: ["memory"] });
  assert.equal(readbackPage.hits.length, 1);
  const readback = await reopened.provider.get({ reference: readbackPage.hits[0]!.reference });
  assert.equal(readback.status, "ok");
  assert.equal(readback.text, "likes tea");
  await reloadedRuntime.closeAllMemorySearchManagers();
});

test("provider rejects missing isolation identity instead of inventing a tenant", async () => {
  const runtime = createNativeMemoryProviderRuntime("memory-tencentdb-client", {
    server: { url: "http://127.0.0.1:8420", apiKey: "local", instanceId: "default" },
  });
  const result = await runtime.open({
    cfg: {},
    agentId: "openclaw-agent-1",
    context: {
      authority: { kind: "operator", scopes: ["operator.read"] },
      assertCurrent() {},
    },
  });
  assert.equal(result.provider, null);
  assert.match(result.error ?? "", /isolation IDs must be configured/);
});

test("provider rejects conversation access without a host-minted session ID", async () => {
  const runtime = createNativeMemoryProviderRuntime("memory-tencentdb-client", {
    server: {
      url: "http://127.0.0.1:8420",
      apiKey: "local",
      instanceId: "default",
      teamId: "team-1",
      agentId: "gateway-agent-1",
      userId: "user-1",
    },
  });
  const result = await runtime.open({
    cfg: {},
    agentId: "openclaw-agent-1",
    context: {
      authority: {
        kind: "session",
        sessionKey: "openclaw/session-key",
        sandboxed: false,
        audience: {
          kind: "conversation",
          agentId: "openclaw-agent-1",
          sessionKey: "openclaw/session-key",
          sessionId: "",
        },
      },
      assertCurrent() {},
    },
  });
  assert.equal(result.provider, null);
  assert.match(result.error ?? "", /audience does not match/);
});

test("older OpenClaw hosts keep the existing hook and tool registration path", () => {
  let tools = 0;
  const hooks: string[] = [];
  const logger = { info() {}, debug() {}, warn() {}, error() {} };
  register({
    id: "memory-tencentdb-client",
    pluginConfig: {},
    logger,
    registerTool() { tools += 1; },
    on(name: string) { hooks.push(name); },
  } as any);

  assert.equal(tools, 3);
  assert.deepEqual(hooks, ["before_prompt_build", "agent_end"]);
});
