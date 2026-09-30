import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getStore, writeToolCall } = vi.hoisted(() => ({
  getStore: vi.fn(), writeToolCall: vi.fn(),
}));
vi.mock("../session/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session/store.js")>()),
  getSessionStore: getStore,
}));
vi.mock("../clickhouse.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../clickhouse.js")>()),
  writeToolCallRow: writeToolCall,
}));

import { DEFAULT_CONFIG } from "../config.js";
import { SessionStore } from "../session/store.js";
import { KvBindingRepo } from "../db/kv-binding-repo.js";
import { MemoryStorage } from "../storage/memory-storage.js";
import { createMemoryBridgeHandler } from "../memory/memory-bridge.js";

describe("Memory Bridge client identity on rejected payloads", () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore();
    getStore.mockReturnValue(store);
    writeToolCall.mockClear();
  });

  async function reject(body: string) {
    const config = structuredClone(DEFAULT_CONFIG);
    config.coreSkill.endpoint = "http://core.test";
    const app = new Hono();
    app.post("/memory-bridge/v3/*", createMemoryBridgeHandler(config));
    return app.request("http://localhost/memory-bridge/v3/atomic/query", {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-conversation-id": "bridge-run", "x-tdai-service-id": "space" },
    });
  }

  it("uses the actual matched L1 client's identity with a bare session ID", async () => {
    await store.set("codebuddy:bridge-run", {
      status: "initialized", keyId: "codebuddy:bridge-run", startedAt: Date.now(), attemptCount: 0,
      sessionInfo: { session_id: "bridge-run", team_id: "team", agent_id: "agent", user_id: "user", space_id: "space" },
    });
    const response = await reject("[]");
    expect(response.status).toBe(400);
    expect(writeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      agentSource: "codebuddy", rejectReason: "body_not_object", userId: "user", teamId: "team", agentId: "agent",
    }));
  });

  it("uses the persisted binding client's identity after an L1 miss", async () => {
    const binding = new KvBindingRepo(new MemoryStorage());
    await binding.putBinding("space", "bridge-run", {
      outcome: "initialized", userId: "user", teamId: "team", agentId: "agent", agentSource: "opencode",
    });
    store.setBindingRepo(binding);
    const response = await reject("{");
    expect(response.status).toBe(400);
    expect(writeToolCall).toHaveBeenCalledWith(expect.objectContaining({
      agentSource: "opencode", rejectReason: "invalid_json_body", userId: "user", teamId: "team", agentId: "agent",
    }));
  });
});
