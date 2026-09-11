import { describe, expect, it } from "vitest";

import {
  DifyWorkflowMemoryAdapter,
  type DifyGatewayHttpFetch,
  type DifyGatewayHttpRequestInit,
  type DifyGatewayMemoryPort,
} from "./index.js";

interface RecordedCall {
  url: string;
  init?: DifyGatewayHttpRequestInit;
}

function makeClient(calls: unknown[]): DifyGatewayMemoryPort {
  return {
    async recall(body) {
      calls.push({ method: "recall", body });
      return { context: "memory context", memory_count: 2, strategy: "hybrid" };
    },
    async capture(body) {
      calls.push({ method: "capture", body });
      return { l0_recorded: 2, scheduler_notified: true };
    },
  };
}

describe("DifyWorkflowMemoryAdapter", () => {
  it("maps Dify workflow input to Gateway recall", async () => {
    const calls: unknown[] = [];
    const adapter = new DifyWorkflowMemoryAdapter({ client: makeClient(calls) });

    const result = await adapter.recall({
      inputs: { query: "project preference" },
      conversation_id: "conv 1",
      user: "user/42",
    });

    expect(result).toEqual({
      session_key: "dify:user_42:conv_1",
      memory_context: "memory context",
      memory_count: 2,
      strategy: "hybrid",
    });
    expect(calls).toEqual([
      {
        method: "recall",
        body: {
          query: "project preference",
          session_key: "dify:user_42:conv_1",
          user_id: "user/42",
        },
      },
    ]);
  });

  it("maps Dify answer output to Gateway capture", async () => {
    const calls: unknown[] = [];
    const adapter = new DifyWorkflowMemoryAdapter({
      client: makeClient(calls),
      platform: "dify-cloud",
    });

    const result = await adapter.capture({
      query: "remember this",
      answer: "stored",
      conversation_id: "conv",
      session_id: "run-1",
      user_id: "u",
      messages: [{ role: "user", content: "remember this" }],
    });

    expect(result).toEqual({
      session_key: "dify-cloud:u:conv:run-1",
      l0_recorded: 2,
      scheduler_notified: true,
    });
    expect(calls).toEqual([
      {
        method: "capture",
        body: {
          user_content: "remember this",
          assistant_content: "stored",
          session_key: "dify-cloud:u:conv:run-1",
          session_id: "run-1",
          user_id: "u",
          messages: [{ role: "user", content: "remember this" }],
        },
      },
    ]);
  });

  it("rejects incomplete capture payloads", async () => {
    const adapter = new DifyWorkflowMemoryAdapter({ client: makeClient([]) });

    await expect(adapter.capture({ query: "only user text" })).rejects.toThrow(
      "Dify capture requires `assistant_content` or `answer`",
    );
  });

  it("posts recall to the Gateway when Dify uses HTTP-only integration", async () => {
    const calls: RecordedCall[] = [];
    const fetchFn: DifyGatewayHttpFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ context: "from gateway", memory_count: 1 }),
      };
    };
    const adapter = new DifyWorkflowMemoryAdapter({
      gateway: {
        baseUrl: "http://127.0.0.1:8420/",
        apiKey: "token",
        fetch: fetchFn,
      },
    });

    await expect(adapter.recall({
      query: "latest project memory",
      conversation_id: "conv",
      user_id: "u",
    })).resolves.toMatchObject({
      memory_context: "from gateway",
      session_key: "dify:u:conv",
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:8420/recall",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer token",
          },
          body: JSON.stringify({
            query: "latest project memory",
            session_key: "dify:u:conv",
            user_id: "u",
          }),
        },
      },
    ]);
  });

  it("keeps the HTTP helper scoped to Dify recall and capture routes", async () => {
    const calls: RecordedCall[] = [];
    const fetchFn: DifyGatewayHttpFetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ l0_recorded: 1, scheduler_notified: true }),
      };
    };
    const adapter = new DifyWorkflowMemoryAdapter({
      gateway: { baseUrl: "http://gateway.local", fetch: fetchFn },
    });

    await adapter.capture({
      query: "remember",
      answer: "done",
      conversation_id: "conv",
      user: "user",
    });

    expect(calls.map((call) => call.url)).toEqual(["http://gateway.local/capture"]);
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toMatchObject({
      user_content: "remember",
      assistant_content: "done",
      session_key: "dify:user:conv",
      user_id: "user",
    });
  });

  it("requires either an injected Dify port or Dify Gateway HTTP options", () => {
    expect(() => new DifyWorkflowMemoryAdapter({})).toThrow(
      "DifyWorkflowMemoryAdapter requires either `client` or `gateway` options",
    );
  });
});
