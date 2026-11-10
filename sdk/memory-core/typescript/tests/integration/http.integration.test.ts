import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TDAMError } from "../../src/errors.js";
import { MemoryClient } from "../../src/v3/client.js";
import { V3HttpTransport } from "../../src/v3/http.js";

interface ReceivedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

let server: Server;
let endpoint: string;
let received: ReceivedRequest[];
let respond: (response: ServerResponse, request: ReceivedRequest) => void;

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function client(timeout = 2_000) {
  return new MemoryClient({
    endpoint, apiKey: "integration-gateway-key", serviceId: "space-a", userKey: "integration-user-key",
    teamId: "team-a", agentId: "agent-a", userId: "user-a", sessionId: "session-a", timeout,
  });
}

beforeEach(async () => {
  received = [];
  respond = (response) => sendJson(response, 200, { code: 0, data: {} });
  server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const captured = {
        method: request.method, url: request.url, headers: request.headers,
        body: text ? JSON.parse(text) as Record<string, unknown> : {},
      };
      received.push(captured);
      respond(response, captured);
    })().catch((error) => response.destroy(error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // A deliberately stalled or broken response must not hold the test runner open.
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
});

describe("SDK over a real local HTTP connection", () => {
  it("sends the SDK isolation context and credentials, preserving Unicode JSON across the wire", async () => {
    const messages = [{ role: "user" as const, content: "请记住：偏好 TypeScript 🧠" }];
    respond = (response) => sendJson(response, 200, { code: 0, data: { accepted_ids: ["message-a"], total_count: 1 } }, {
      "x-trace-id": "trace-from-server",
    });
    await expect(client().addConversation({ messages })).resolves.toEqual({
      accepted_ids: ["message-a"], total_count: 1, trace_id: "trace-from-server",
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: "POST", url: "/v3/conversation/add",
      headers: {
        authorization: "Bearer integration-gateway-key", "x-tdai-service-id": "space-a",
        "x-tdai-user-key": "integration-user-key", "content-type": "application/json",
      },
      body: { team_id: "team-a", agent_id: "agent-a", user_id: "user-a", session_id: "session-a", messages },
    });
  });

  it("keeps a cloned client's per-call identity separate on the shared transport", async () => {
    const original = client();
    const clone = original.withIsolation({ userId: "user-b", sessionId: null });
    await clone.queryConversation({ limit: 2 });
    await original.queryConversation({ session_id: "session-override" });
    expect(received.map((request) => request.body)).toEqual([
      { team_id: "team-a", agent_id: "agent-a", user_id: "user-b", limit: 2 },
      { team_id: "team-a", agent_id: "agent-a", user_id: "user-a", session_id: "session-override" },
    ]);
  });

  it("encodes actual GET query parameters without emitting a JSON request body", async () => {
    const transport = new V3HttpTransport({ endpoint, apiKey: "key", serviceId: "space-a" });
    await transport.get("/v3/meta/asset/list", { query: "空格 & /", limit: 0, archived: false, absent: undefined });
    const url = new URL(received[0].url!, endpoint);
    expect(received[0].method).toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: "空格 & /", limit: "0", archived: "false" });
    expect(received[0].body).toEqual({});
    expect(received[0].headers["x-tdai-user-key"]).toBeUndefined();
  });

  it("reads a chunked response as one JSON envelope", async () => {
    respond = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"code":0,"data":{"content":"');
      response.write("跨分片的回答");
      response.end('"}}');
    };
    await expect(client().readCore()).resolves.toEqual({ content: "跨分片的回答" });
  });

  it("preserves business error details and the request ID supplied by the HTTP server", async () => {
    respond = (response) => sendJson(response, 409, {
      code: 40901, message: "version stale", request_id: "body-request-id", data: { current_version: 8 },
    }, { "x-qcloud-transaction-id": "header-request-id" });
    const error = await client().readCore().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TDAMError);
    expect(error).toMatchObject({ code: 40901, requestId: "header-request-id", details: { current_version: 8 } });
  });

  it("classifies a gateway's non-JSON failure without losing its HTTP status", async () => {
    respond = (response) => {
      response.writeHead(502, { "content-type": "text/html", "x-trace-id": "gateway-trace" });
      response.end("<html>Upstream unavailable</html>");
    };
    await expect(client().readCore()).rejects.toMatchObject({ name: "TDAMError", code: 502, requestId: "gateway-trace" });
  });

  it("rejects a JSON null success response as an invalid envelope", async () => {
    respond = (response) => sendJson(response, 200, null);
    await expect(client().readCore()).rejects.toMatchObject({ name: "TDAMError", code: -1 });
  });

  it("rejects when the peer closes its socket before sending response headers", async () => {
    respond = (response) => response.socket!.destroy();
    await expect(client().readCore()).rejects.toBeInstanceOf(TypeError);
    expect(received).toHaveLength(1);
  });

  it("aborts when the server never sends response headers", async () => {
    respond = () => {};
    await expect(client(150).readCore()).rejects.toMatchObject({ name: "AbortError" });
    expect(received).toHaveLength(1);
  });

  it("preserves cancellation when headers arrive but the response body stalls", async () => {
    respond = (response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write('{"code":0,"data":');
    };
    await expect(client(150).readCore()).rejects.toMatchObject({ name: "AbortError" });
    expect(received).toHaveLength(1);
  });
});
