import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import { __resetDbForTests } from "../db/index.js";
import { __resetSessionRepoForTests } from "../db/sessionRepo.js";
import { setMetadataClient } from "../meta/client.js";
import { createApp } from "../server.js";
import { __resetSessionStoreForTests } from "../session/store.js";
import { flushPendingWrites } from "../tdai/pending-writes.js";
import type { ProxyConfig } from "../types.js";

const servers: Server[] = [];
const tempDirs: string[] = [];
const originalProxyDbPath = process.env.PROXY_DB_PATH;

beforeEach(() => {
  __resetSessionStoreForTests();
  __resetSessionRepoForTests();
  __resetDbForTests();
  const tempDir = mkdtempSync(join(tmpdir(), "memory-proxy-l0-test-"));
  tempDirs.push(tempDir);
  process.env.PROXY_DB_PATH = join(tempDir, "proxy.db");
});

afterEach(async () => {
  await flushPendingWrites();
  setMetadataClient(null);
  __resetSessionStoreForTests();
  __resetSessionRepoForTests();
  __resetDbForTests();
  if (originalProxyDbPath === undefined) delete process.env.PROXY_DB_PATH;
  else process.env.PROXY_DB_PATH = originalProxyDbPath;
  await Promise.all(servers.splice(0).map(closeServer));
  for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
});

describe("OpenAI L0 round finalization", () => {
  it("writes only the final answer for a non-streaming tool round", async () => {
    const memoryWrites: Record<string, unknown>[] = [];
    const core = createCore(memoryWrites);
    const upstream = createUpstream(["tool", "final"], false);
    servers.push(core, upstream);

    const app = createApp(testConfig(await listen(upstream), await listen(core)));
    const sessionId = "non-stream-tool-round";

    const toolResponse = await requestCompletion(app, sessionId, false, [
      { role: "user", content: "Inspect disk usage" },
    ]);
    expect(toolResponse.status).toBe(200);
    expect(memoryWrites).toHaveLength(0);

    const finalResponse = await requestCompletion(app, sessionId, false, [
      { role: "user", content: "Inspect disk usage" },
      {
        role: "assistant",
        content: null,
        tool_calls: [terminalToolCall()],
      },
      {
        role: "tool",
        tool_call_id: "call-terminal-1",
        content: "Filesystem usage: 42%",
      },
    ]);
    expect(finalResponse.status).toBe(200);
    expect(memoryWrites).toHaveLength(1);
    expect(memoryWrites[0]?.messages).toEqual([
      { role: "user", content: "Inspect disk usage" },
      { role: "assistant", content: "Disk usage is 42%." },
    ]);
  });

  it("writes only the final answer for a streaming tool round", async () => {
    const memoryWrites: Record<string, unknown>[] = [];
    const core = createCore(memoryWrites);
    const upstream = createUpstream(["tool", "final"], true);
    servers.push(core, upstream);

    const app = createApp(testConfig(await listen(upstream), await listen(core)));
    const sessionId = "stream-tool-round";

    const toolResponse = await requestCompletion(app, sessionId, true, [
      { role: "user", content: "Inspect disk usage" },
    ]);
    expect(toolResponse.status).toBe(200);
    await toolResponse.text();
    await flushPendingWrites();
    expect(memoryWrites).toHaveLength(0);

    const finalResponse = await requestCompletion(app, sessionId, true, [
      { role: "user", content: "Inspect disk usage" },
      {
        role: "assistant",
        content: null,
        tool_calls: [terminalToolCall()],
      },
      {
        role: "tool",
        tool_call_id: "call-terminal-1",
        content: "Filesystem usage: 42%",
      },
    ]);
    expect(finalResponse.status).toBe(200);
    await finalResponse.text();
    await flushPendingWrites();
    expect(memoryWrites).toHaveLength(1);
    expect(memoryWrites[0]?.messages).toEqual([
      { role: "user", content: "Inspect disk usage" },
      { role: "assistant", content: "Disk usage is 42%." },
    ]);
  });
});

type CompletionKind = "tool" | "final";

function createUpstream(kinds: CompletionKind[], streaming: boolean): Server {
  const queue = [...kinds];
  return createServer(async (request, response) => {
    await readJson(request);
    const kind = queue.shift();
    if (!kind) {
      response.writeHead(500).end("unexpected upstream request");
      return;
    }
    if (streaming) {
      writeStreamingCompletion(response, kind);
      return;
    }
    writeJson(response, completionBody(kind));
  });
}

function createCore(memoryWrites: Record<string, unknown>[]): Server {
  return createServer(async (request, response) => {
    const body = await readJson(request);
    const path = request.url ?? "";
    if (path === "/v3/conversation/add") {
      memoryWrites.push(body);
      writeJson(response, { code: 0, data: {} });
      return;
    }
    if (path === "/v3/meta/agent/get") {
      writeJson(response, {
        code: 0,
        data: { agent_id: "agent-test", team_id: "team-test", name: "Test Agent" },
      });
      return;
    }
    if (path === "/v3/meta/task/get") {
      writeJson(response, {
        code: 0,
        data: { task_id: "task-test", team_id: "team-test", title: "Test Task" },
      });
      return;
    }
    if (path === "/v3/meta/config/user/get") {
      writeJson(response, { code: 0, data: { items: [] } });
      return;
    }
    writeJson(response, { code: 0, data: {} });
  });
}

function testConfig(upstreamUrl: string, coreUrl: string): ProxyConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.upstream.url = upstreamUrl;
  config.upstream.apiKey = "upstream-test-key";
  config.server.forwardTimeoutMs = 2_000;
  config.rateLimit = { tpm: 0, qpm: 0 };
  config.creditReport = { url: `${coreUrl}/credit-report`, timeoutMs: 100 };
  config.injection.enabled = false;
  config.extraction = { enabled: true, extractors: ["tdai-memory"] };
  config.sessionInit = {
    ...config.sessionInit,
    enabled: true,
    debugForceIdentity: {
      team_id: "team-test",
      agent_id: "agent-test",
      task_id: "task-test",
    },
  };
  config.tdai = {
    enabled: true,
    endpoint: coreUrl,
    apiKey: "local-test-key",
    serviceId: "space-test",
    memory: {
      enabled: true,
      inject: false,
      writeL0: true,
      recallL1: false,
      injectL2L3: false,
      l1Limit: 5,
      l2Limit: 3,
      timeoutMs: 2_000,
    },
  };
  config.coreSkill = {
    endpoint: coreUrl,
    serviceToken: "local-test-key",
    serviceId: "space-test",
    timeoutMs: 2_000,
  };
  return config;
}

async function requestCompletion(
  app: ReturnType<typeof createApp>,
  sessionId: string,
  stream: boolean,
  messages: Record<string, unknown>[],
): Promise<Response> {
  return app.request("/codebuddy/space-test/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": "Bearer user-test-key",
      "content-type": "application/json",
      "x-conversation-id": sessionId,
      "x-user-id": "user-test",
    },
    body: JSON.stringify({ model: "test-model", stream, messages }),
  });
}

function terminalToolCall(): Record<string, unknown> {
  return {
    id: "call-terminal-1",
    type: "function",
    function: { name: "terminal", arguments: "{\"command\":\"df -h\"}" },
  };
}

function completionBody(kind: CompletionKind): Record<string, unknown> {
  const message = kind === "tool"
    ? { role: "assistant", content: null, tool_calls: [terminalToolCall()] }
    : { role: "assistant", content: "Disk usage is 42%." };
  return {
    id: `chatcmpl-${kind}`,
    object: "chat.completion",
    model: "test-model",
    choices: [{ index: 0, message, finish_reason: kind === "tool" ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function writeStreamingCompletion(response: ServerResponse, kind: CompletionKind): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const delta = kind === "tool"
    ? { tool_calls: [{ index: 0, ...terminalToolCall() }] }
    : { content: "Disk usage is 42%." };
  writeSse(response, {
    id: `chatcmpl-${kind}`,
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  writeSse(response, {
    id: `chatcmpl-${kind}`,
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: kind === "tool" ? "tool_calls" : "stop" }],
  });
  writeSse(response, {
    id: `chatcmpl-${kind}`,
    object: "chat.completion.chunk",
    model: "test-model",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  response.end("data: [DONE]\n\n");
}

function writeSse(response: ServerResponse, event: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) text += String(chunk);
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function writeJson(response: ServerResponse, body: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
