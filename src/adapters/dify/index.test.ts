import { describe, expect, it } from "vitest";

import { DifyWorkflowMemoryAdapter, type GatewayMemoryClient } from "./index.js";

function makeClient(calls: unknown[]): GatewayMemoryClient {
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
});
