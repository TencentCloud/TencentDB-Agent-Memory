/**
 * Unit tests for MemoryClient (mock transport, no network).
 */

import { describe, it, expect } from "vitest";
import { MemoryClient } from "../src/client.js";
import type { Transport } from "../src/client.js";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

class MockTransport implements Transport {
  calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  responses: Record<string, unknown> = {};

  async post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ path, body });
    return (this.responses[path] ?? {}) as T;
  }
}

function createMock(): MockTransport {
  const m = new MockTransport();
  m.responses = {
    "/v2/conversation/add": { accepted_ids: ["msg-1"], total_count: 1 },
    "/v2/conversation/query": { messages: [], total: 0 },
    "/v2/conversation/search": { messages: [] },
    "/v2/conversation/delete": { deleted_count: 2 },
    "/v2/atomic/update": { id: "note-1", updated_at: "t" },
    "/v2/atomic/query": { items: [], total: 0 },
    "/v2/atomic/search": { items: [] },
    "/v2/atomic/delete": { deleted_count: 1 },
    "/v2/scenario/ls": { entries: [], total: 0 },
    "/v2/scenario/read": { path: "a.md", content: "# hi", created_at: "t", updated_at: "t" },
    "/v2/scenario/write": { path: "a.md", updated_at: "t" },
    "/v2/scenario/rm": {},
    "/v2/core/read": { content: "# core", created_at: "t", updated_at: "t" },
    "/v2/core/write": { updated_at: "t" },
    "/v2/offload/read-ref": {
      result_ref: "offload/s1/refs/call-1.md",
      content: "archived result",
      truncated: false,
    },
  };
  return m;
}

// ---------------------------------------------------------------------------
// L0 Conversation
// ---------------------------------------------------------------------------

describe("L0 Conversation", () => {
  it("addConversation sends correct body", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    const result = await client.addConversation({
      session_id: "s1",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.accepted_ids).toEqual(["msg-1"]);
    expect(mock.calls[0]!.path).toBe("/v2/conversation/add");
    expect(mock.calls[0]!.body).toEqual({
      session_id: "s1",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("queryConversation strips undefined", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.queryConversation({ session_id: "s", limit: 10 });
    expect(mock.calls[0]!.body).toEqual({ session_id: "s", limit: 10 });
  });

  it("queryConversation with no params", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.queryConversation();
    expect(mock.calls[0]!.body).toEqual({});
  });

  it("searchConversation", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.searchConversation({ query: "rust", limit: 5 });
    expect(mock.calls[0]!.body).toEqual({ query: "rust", limit: 5 });
  });

  it("deleteConversation by ids", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    const result = await client.deleteConversation({ message_ids: ["m1", "m2"] });
    expect(result.deleted_count).toBe(2);
    expect(mock.calls[0]!.body).toEqual({ message_ids: ["m1", "m2"] });
  });

  it("deleteConversation by session", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.deleteConversation({ session_id: "s1" });
    expect(mock.calls[0]!.body).toEqual({ session_id: "s1" });
  });
});

// ---------------------------------------------------------------------------
// L1 Atomic
// ---------------------------------------------------------------------------

describe("L1 Atomic", () => {
  it("updateAtomic", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    const result = await client.updateAtomic({ id: "note-1", content: "likes rust" });
    expect(result.id).toBe("note-1");
    expect(mock.calls[0]!.body).toEqual({ id: "note-1", content: "likes rust" });
  });

  it("queryAtomic with filters", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.queryAtomic({ type: "persona", limit: 5 });
    expect(mock.calls[0]!.body).toEqual({ type: "persona", limit: 5 });
  });

  it("searchAtomic", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.searchAtomic({ query: "programming", type: "episodic" });
    expect(mock.calls[0]!.body).toEqual({ query: "programming", type: "episodic" });
  });

  it("deleteAtomic", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    const result = await client.deleteAtomic({ ids: ["n1"] });
    expect(result.deleted_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// L2 Scenario
// ---------------------------------------------------------------------------

describe("L2 Scenario", () => {
  it("listScenarios", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.listScenarios({ path_prefix: "工作/" });
    expect(mock.calls[0]!.body).toEqual({ path_prefix: "工作/" });
  });

  it("readScenario", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    const result = await client.readScenario({ path: "a.md" });
    expect(result.content).toBe("# hi");
  });

  it("writeScenario", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.writeScenario({ path: "b.md", content: "# content" });
    expect(mock.calls[0]!.body).toEqual({ path: "b.md", content: "# content" });
  });

  it("rmScenario", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.rmScenario({ path: "b.md" });
    expect(mock.calls[0]!.body).toEqual({ path: "b.md" });
  });
});

// ---------------------------------------------------------------------------
// L3 Core
// ---------------------------------------------------------------------------

describe("L3 Core", () => {
  it("readCore", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    const result = await client.readCore();
    expect(result.content).toBe("# core");
  });

  it("writeCore", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    await client.writeCore({ content: "# new core" });
    expect(mock.calls[0]!.body).toEqual({ content: "# new core" });
  });
});

// ---------------------------------------------------------------------------
// Offload
// ---------------------------------------------------------------------------

describe("Offload", () => {
  it("offloadReadRef sends the reference and strips undefined filters", async () => {
    const mock = createMock();
    const client = new MemoryClient(mock);
    const result = await client.offloadReadRef({
      session_id: "s1",
      result_ref: "offload/s1/refs/call-1.md",
      query: "result",
      max_tokens: 800,
    });

    expect(result.content).toBe("archived result");
    expect(mock.calls[0]!.path).toBe("/v2/offload/read-ref");
    expect(mock.calls[0]!.body).toEqual({
      session_id: "s1",
      result_ref: "offload/s1/refs/call-1.md",
      query: "result",
      max_tokens: 800,
    });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Config validation", () => {
  it("throws when no serviceId", () => {
    expect(() => new MemoryClient({ endpoint: "http://x", apiKey: "k" })).toThrow(
      "serviceId",
    );
  });
});
