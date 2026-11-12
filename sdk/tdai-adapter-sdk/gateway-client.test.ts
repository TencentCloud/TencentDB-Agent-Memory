import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TdaiGatewayClient, TdaiGatewayError } from "./gateway-client.js";

interface Captured {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

let server: http.Server;
let baseUrl: string;
let captured: Captured[] = [];
/** Per-path scripted responses: status + body (defaults to 200 {}). */
let responses: Record<string, { status?: number; body?: string; delayMs?: number }> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const script = responses[req.url ?? ""] ?? {};
      const respond = () => {
        res.statusCode = script.status ?? 200;
        res.setHeader("Content-Type", "application/json");
        res.end(script.body ?? "{}");
      };
      if (script.delayMs) setTimeout(respond, script.delayMs);
      else respond();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

function lastRequest(): Captured {
  const last = captured[captured.length - 1];
  if (!last) throw new Error("no request captured");
  return last;
}

describe("TdaiGatewayClient", () => {
  beforeEach(() => {
    captured = [];
    responses = {};
  });

  it("GET /health hits the health endpoint without a body", async () => {
    const client = new TdaiGatewayClient({ baseUrl });
    responses["/health"] = { body: JSON.stringify({ status: "ok" }) };
    const res = await client.health();
    expect(res.status).toBe("ok");
    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/health");
    expect(req.body).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
  });

  it("POST /recall sends snake_case wire format", async () => {
    const client = new TdaiGatewayClient({ baseUrl });
    responses["/recall"] = { body: JSON.stringify({ context: "ctx" }) };
    const res = await client.recall({ query: "q", sessionKey: "s1", userId: "u1" });
    expect(res.context).toBe("ctx");
    expect(lastRequest().body).toEqual({ query: "q", session_key: "s1", user_id: "u1" });
  });

  it("POST /capture sends snake_case wire format", async () => {
    const client = new TdaiGatewayClient({ baseUrl });
    await client.capture({
      userContent: "hello",
      assistantContent: "world",
      sessionKey: "s1",
      sessionId: "sid",
    });
    expect(lastRequest().body).toEqual({
      user_content: "hello",
      assistant_content: "world",
      session_key: "s1",
      session_id: "sid",
    });
  });

  it("POST /search/memories and /search/conversations pass optional filters", async () => {
    const client = new TdaiGatewayClient({ baseUrl });
    await client.searchMemories({ query: "q", limit: 3, type: "record", scene: "sc" });
    expect(lastRequest().url).toBe("/search/memories");
    expect(lastRequest().body).toEqual({ query: "q", limit: 3, type: "record", scene: "sc" });

    await client.searchConversations({ query: "q2", sessionKey: "s" });
    expect(lastRequest().url).toBe("/search/conversations");
    expect(lastRequest().body).toEqual({ query: "q2", session_key: "s" });
  });

  it("POST /session/end and /seed use the documented body shapes", async () => {
    const client = new TdaiGatewayClient({ baseUrl });
    await client.endSession({ sessionKey: "s9" });
    expect(lastRequest().url).toBe("/session/end");
    expect(lastRequest().body).toEqual({ session_key: "s9" });

    await client.seed({ data: [1], sessionKey: "s", strictRoundRole: true });
    expect(lastRequest().url).toBe("/seed");
    expect(lastRequest().body).toEqual({ data: [1], session_key: "s", strict_round_role: true });
  });

  it("attaches Authorization: Bearer when apiKey is set", async () => {
    const client = new TdaiGatewayClient({ baseUrl, apiKey: "top-secret" });
    await client.health();
    expect(lastRequest().headers.authorization).toBe("Bearer top-secret");
  });

  it("rejects with TdaiGatewayError on non-2xx responses", async () => {
    const client = new TdaiGatewayClient({ baseUrl });
    responses["/recall"] = { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
    await expect(client.recall({ query: "q" })).rejects.toMatchObject({
      name: "TdaiGatewayError",
      status: 401,
      path: "/recall",
    });
  });

  it("rejects with TdaiGatewayError when the request times out", async () => {
    const client = new TdaiGatewayClient({ baseUrl, timeoutMs: 100 });
    responses["/health"] = { delayMs: 2_000 };
    await expect(client.health()).rejects.toBeInstanceOf(TdaiGatewayError);
  });

  it("rejects with TdaiGatewayError when the Gateway is unreachable", async () => {
    const client = new TdaiGatewayClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    await expect(client.health()).rejects.toBeInstanceOf(TdaiGatewayError);
  });
});
