import { describe, expect, it } from "vitest";

import {
  GatewayClientError,
  TdaiGatewayClient,
  createGatewaySessionKey,
  type GatewayFetch,
  type GatewayRequestInit,
} from "./gateway-client.js";

interface RecordedCall {
  url: string;
  init?: GatewayRequestInit;
}

function makeFetch(response: { status?: number; body: unknown }, calls: RecordedCall[]): GatewayFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      text: async () => JSON.stringify(response.body),
    };
  };
}

describe("TdaiGatewayClient", () => {
  it("calls health without a request body", async () => {
    const calls: RecordedCall[] = [];
    const client = new TdaiGatewayClient({
      baseUrl: "http://127.0.0.1:8420/",
      fetch: makeFetch({
        body: {
          status: "ok",
          version: "0.1.0",
          uptime: 1,
          stores: { vectorStore: true, embeddingService: false },
        },
      }, calls),
    });

    await expect(client.health()).resolves.toMatchObject({ status: "ok" });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8420/health",
        init: { method: "GET", headers: {}, body: undefined },
      },
    ]);
  });

  it("posts recall requests with bearer auth", async () => {
    const calls: RecordedCall[] = [];
    const client = new TdaiGatewayClient({
      baseUrl: "http://gateway.local",
      apiKey: "secret",
      fetch: makeFetch({ body: { context: "remembered", memory_count: 1, strategy: "hybrid" } }, calls),
    });

    const result = await client.recall({
      query: "what does the user prefer?",
      session_key: "dify:user:conv",
      user_id: "user",
    });

    expect(result.context).toBe("remembered");
    expect(calls[0].url).toBe("http://gateway.local/recall");
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toMatchObject({
      query: "what does the user prefer?",
      session_key: "dify:user:conv",
      user_id: "user",
    });
  });

  it("throws GatewayClientError for non-2xx responses", async () => {
    const calls: RecordedCall[] = [];
    const client = new TdaiGatewayClient({
      baseUrl: "http://gateway.local",
      fetch: makeFetch({ status: 401, body: { error: "Unauthorized: invalid token" } }, calls),
    });

    await expect(client.searchMemories({ query: "x" })).rejects.toMatchObject({
      name: "GatewayClientError",
      status: 401,
      message: "Unauthorized: invalid token",
    } satisfies Partial<GatewayClientError>);
  });
});

describe("createGatewaySessionKey", () => {
  it("builds deterministic sanitized keys", () => {
    expect(createGatewaySessionKey({
      platform: "dify workflow",
      userId: "user/42",
      conversationId: "conv 1",
      sessionId: "node#a",
    })).toBe("dify_workflow:user_42:conv_1:node_a");
  });
});
