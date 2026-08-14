import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { TdaiClientError, TdaiMemoryClient, turnKey } from "../src/client.js";
import type { PiMemoryConfig } from "../src/config.js";

type RequestRecord = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

function startServer(
  handler: (req: http.IncomingMessage, body: unknown, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string; requests: RequestRecord[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const requests: RequestRecord[] = [];
    const server = http.createServer((req, res) => {
      let chunks = "";
      req.on("data", (chunk) => {
        chunks += chunk.toString();
      });
      req.on("end", () => {
        let parsed: unknown = chunks;
        try {
          parsed = chunks ? JSON.parse(chunks) : undefined;
        } catch {
          parsed = chunks;
        }
        requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: parsed });
        handler(req, parsed, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        server,
        url: "http://127.0.0.1:" + address.port,
        requests,
        close: () => new Promise((res2) => server.close(() => res2())),
      });
    });
  });
}

function makeConfig(overrides: Partial<PiMemoryConfig> = {}): PiMemoryConfig {
  return {
    endpoint: "",
    apiKey: "k",
    serviceId: "s",
    teamId: "t",
    agentId: "a",
    userId: "u",
    timeoutMs: 5_000,
    recallLimit: 5,
    scenarioLimit: 3,
    maxContextChars: 8_000,
    maxCaptureChars: 8_000,
    maxSkillBytes: 512_000,
    includeCore: true,
    includeScenarios: true,
    allowInsecureHttp: true,
    ...overrides,
  } as PiMemoryConfig;
}

function json(res: http.ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

describe("TdaiMemoryClient", () => {
  let env: Awaited<ReturnType<typeof startServer>>;

  beforeEach(async () => {
    env = await startServer((_req, _body, res) => json(res, { code: 0, message: "ok", data: {} }));
  });
  afterEach(async () => {
    await env.close();
  });

  it("sends isolation fields and client_message_id on every captureTurn", async () => {
    const client = new TdaiMemoryClient(makeConfig({ endpoint: env.url }));
    await client.captureTurn({
      sessionId: "sess",
      user: "hi",
      assistant: "hello",
      capturedAtMs: 1_000,
    });
    const req = env.requests[0];
    expect(req?.url).toBe("/v3/conversation/add");
    expect(req?.headers.authorization).toBe("Bearer k");
    expect(req?.headers["x-tdai-service-id"]).toBe("s");
    expect(req?.body).toMatchObject({
      team_id: "t",
      agent_id: "a",
      user_id: "u",
      session_id: "sess",
    });
    expect((req?.body as { client_message_id?: string }).client_message_id).toBe(
      turnKey({ sessionId: "sess", user: "hi", assistant: "hello" }),
    );
  });

  it("posts skill messages to /v3/skill/conversation/add with a suffixed idempotency key", async () => {
    const client = new TdaiMemoryClient(makeConfig({ endpoint: env.url }));
    await client.captureSkill({
      sessionId: "sess",
      user: "hi",
      assistant: "hello",
      capturedAtMs: 1_000,
      skillMessages: [{ role: "tool_call", content: "{}", tool_call_id: "c1" }],
    });
    const req = env.requests[0];
    expect(req?.url).toBe("/v3/skill/conversation/add");
    const id = (req?.body as { client_message_id?: string }).client_message_id ?? "";
    expect(id.endsWith("-skill")).toBe(true);
  });

  it("skips captureSkill when there are no skill messages", async () => {
    const client = new TdaiMemoryClient(makeConfig({ endpoint: env.url }));
    await client.captureSkill({ sessionId: "sess", user: "hi", assistant: "hello", capturedAtMs: 1 });
    expect(env.requests.length).toBe(0);
  });

  it("returns conversation messages from search", async () => {
    await env.close();
    env = await startServer((_req, _body, res) =>
      json(res, { code: 0, data: { messages: [{ role: "user", content: "past" }] } }),
    );
    const client = new TdaiMemoryClient(makeConfig({ endpoint: env.url }));
    const messages = await client.searchConversation("q", 5);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("past");
  });

  it("aggregates recall and records partial-failure warnings without throwing", async () => {
    await env.close();
    let count = 0;
    env = await startServer((req, _body, res) => {
      count += 1;
      if (req.url === "/v3/core/read") {
        json(res, { code: 500, message: "core down" });
        return;
      }
      if (req.url === "/v3/atomic/search") {
        json(res, { code: 0, data: { items: [{ id: "1", type: "fact", content: "c" }] } });
        return;
      }
      json(res, { code: 0, data: { entries: [] } });
    });
    const client = new TdaiMemoryClient(makeConfig({ endpoint: env.url }));
    const bundle = await client.recall("q");
    expect(bundle.atomic).toHaveLength(1);
    expect(bundle.core).toBeNull();
    expect(bundle.warnings.some((w) => w.includes("core"))).toBe(true);
    expect(count).toBeGreaterThan(0);
  });

  it("returns null from check when total is missing (connected but malformed)", async () => {
    await env.close();
    env = await startServer((_req, _body, res) => json(res, { code: 0, data: {} }));
    const client = new TdaiMemoryClient(makeConfig({ endpoint: env.url }));
    expect(await client.check()).toBeNull();
  });

  it("throws TdaiClientError on a business error code (HTTP 200, code !== 0)", async () => {
    await env.close();
    env = await startServer((_req, _body, res) => json(res, { code: 4001, message: "bad request" }));
    const client = new TdaiMemoryClient(makeConfig({ endpoint: env.url }));
    await expect(client.check()).rejects.toMatchObject({
      name: "TdaiClientError",
      code: 4001,
      message: "bad request",
    });
  });

  it("throws on a non-JSON response", async () => {
    await env.close();
    env = await startServer((_req, _body, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json");
    });
    const client = new TdaiMemoryClient(makeConfig({ endpoint: env.url }));
    await expect(client.check()).rejects.toMatchObject({ name: "TdaiClientError" });
  });

  it("aborts immediately when the caller passes an already-aborted signal", async () => {
    await env.close();
    env = await startServer((_req, _body, res) => {
      // Server would respond, but the client must abort before relying on it.
      json(res, { code: 0, data: { total: 1 } });
    });
    const client = new TdaiMemoryClient(
      makeConfig({ endpoint: env.url, timeoutMs: 5_000 }),
    );
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await expect(client.check(controller.signal)).rejects.toMatchObject({
      name: "TdaiClientError",
      message: "MemoryCore request aborted by caller",
    });
    // Must not wait for the 5s timeout.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("reports a timeout distinctly from a caller abort", async () => {
    await env.close();
    env = await startServer((_req, _body, res) => {
      setTimeout(() => json(res, { code: 0, data: { total: 1 } }), 1_000);
    });
    const client = new TdaiMemoryClient(
      makeConfig({ endpoint: env.url, timeoutMs: 60 }),
    );
    await expect(client.check()).rejects.toMatchObject({
      name: "TdaiClientError",
      message: expect.stringContaining("timed out"),
    });
  });

  it("reports a caller abort distinctly from a timeout", async () => {
    await env.close();
    env = await startServer((_req, _body, res) => {
      setTimeout(() => json(res, { code: 0, data: { total: 1 } }), 1_000);
    });
    const client = new TdaiMemoryClient(
      makeConfig({ endpoint: env.url, timeoutMs: 5_000 }),
    );
    const controller = new AbortController();
    const pending = client.check(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "TdaiClientError",
      message: "MemoryCore request aborted by caller",
    });
  });
});
