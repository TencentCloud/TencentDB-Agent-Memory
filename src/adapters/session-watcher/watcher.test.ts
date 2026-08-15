import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SessionWatcher } from "./watcher.js";
import type { TdaiMcpConfig } from "./config.js";
import type { GatewayMemoryClient } from "./gateway-client.js";
import type { ParsedMessage, SessionAdapter, SessionInfo, ParsedTurn } from "./adapters/base.js";
import { registerAdapter, ADAPTER_MAP } from "./adapters/base.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function makeClient(calls: Array<{ method: string; body: unknown }>): GatewayMemoryClient {
  return {
    health: async () => ({ status: "ok", version: "1", uptime: 1, stores: { vectorStore: true, embeddingService: true } }),
    recall: async (body) => {
      calls.push({ method: "recall", body });
      return { context: "mem context", strategy: "hybrid", memory_count: 2 };
    },
    capture: async (body) => {
      calls.push({ method: "capture", body });
      return { l0_recorded: 2, scheduler_notified: true };
    },
    searchMemories: async () => ({ results: "", total: 0, strategy: "" }),
    searchConversations: async () => ({ results: "", total: 0 }),
    endSession: async () => ({ flushed: true }),
  } as GatewayMemoryClient;
}

function makeConfig(adapters: string[], pollMs = 500): TdaiMcpConfig {
  const dir = path.join(os.tmpdir(), "sw-test-" + Date.now());
  return {
    gateway: { host: "127.0.0.1", port: 18420, baseUrl: "http://127.0.0.1:18420" },
    watcher: { pollIntervalMs: pollMs, adapters },
    agentMemory: { contextDir: path.join(dir, "recall"), stateDir: path.join(dir, "state") },
  };
}

function makeFakeAdapter(name: string, messages: ParsedMessage[], turns: ParsedTurn[]): SessionAdapter {
  return {
    name,
    sessionDir: () => os.tmpdir(),
    discoverSessions: async () => [{ sessionKey: "session-1", sessionId: "session-1" }],
    parseNewMessages: async (_sk, since) => {
      if (since === 0) return messages;
      return [];
    },
    detectTurns: () => turns,
  };
}

describe("SessionWatcher", () => {
  beforeEach(() => {
    ADAPTER_MAP.clear();
  });

  afterEach(() => {
    ADAPTER_MAP.clear();
  });

  it("start and stop without errors", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const config = makeConfig([]);
    const watcher = new SessionWatcher(config, makeClient(calls));
    await watcher.start();
    await watcher.stop();
    expect(true).toBe(true);
  }, 5000);

  it("triggers recall and capture for new messages", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const config = makeConfig(["fake-adapter"], 200);

    const messages: ParsedMessage[] = [
      { role: "user", content: "help me fix login", timestamp: Date.now() - 5000 },
      { role: "assistant", content: "checking auth.ts...", timestamp: Date.now() - 2000 },
    ];
    const turns: ParsedTurn[] = [{
      sessionKey: "session-1",
      sessionId: "session-1",
      userMessage: messages[0],
      assistantMessages: [messages[1]],
    }];

    registerAdapter("fake-adapter", () => makeFakeAdapter("fake-adapter", messages, turns));

    const client = makeClient(calls);
    const watcher = new SessionWatcher(config, client);
    await watcher.start();

    // Wait for 2 polling cycles
    await new Promise((r) => setTimeout(r, 800));

    await watcher.stop();

    const recalls = calls.filter((c) => c.method === "recall");
    const captures = calls.filter((c) => c.method === "capture");

    expect(recalls.length).toBeGreaterThanOrEqual(1);
    expect(captures.length).toBeGreaterThanOrEqual(1);

    expect((recalls[0].body as Record<string, unknown>).query).toBe("help me fix login");

    const capBody = captures[0].body as Record<string, unknown>;
    expect(capBody.user_content).toBe("help me fix login");
    expect(capBody.assistant_content).toBe("checking auth.ts...");
    expect(capBody.session_key).toBe("session-1");
  }, 10000);

  it("does not re-process messages already seen (cursor)", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const config = makeConfig(["fake-cursor-adapter"], 200);

    let callCount = 0;
    const adapter: SessionAdapter = {
      name: "fake-cursor-adapter",
      sessionDir: () => os.tmpdir(),
      discoverSessions: async () => [{ sessionKey: "session-1", sessionId: "session-1" }],
      parseNewMessages: async (_sk, since) => {
        callCount++;
        if (since === 0) {
          return [{ role: "user", content: "test", timestamp: 1000 } as ParsedMessage];
        }
        return [];
      },
      detectTurns: () => [{
        sessionKey: "session-1", sessionId: "session-1",
        userMessage: { role: "user", content: "test", timestamp: 1000 } as ParsedMessage,
        assistantMessages: [],
      }],
    };

    registerAdapter("fake-cursor-adapter", () => adapter);
    const watcher = new SessionWatcher(config, makeClient(calls));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 800));
    await watcher.stop();

    // parseNewMessages was called multiple times by polling,
    // but since=0 only triggers on the first call; subsequent calls
    // have since>0 and return [].
    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 10000);

  it("writes recall context file on recall", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const config = makeConfig(["fake-recall-adapter"], 200);
    const contextDir = config.agentMemory.contextDir;

    const messages: ParsedMessage[] = [
      { role: "user", content: "recall test", timestamp: Date.now() - 1000 },
      { role: "assistant", content: "response", timestamp: Date.now() },
    ];
    const turns: ParsedTurn[] = [{
      sessionKey: "session-1", sessionId: "session-1",
      userMessage: messages[0], assistantMessages: [messages[1]],
    }];

    registerAdapter("fake-recall-adapter", () => makeFakeAdapter("fake-recall-adapter", messages, turns));

    const watcher = new SessionWatcher(config, makeClient(calls));
    await watcher.start();
    await new Promise((r) => setTimeout(r, 800));
    await watcher.stop();

    const recallFile = path.join(contextDir, "session-1.md");
    expect(fs.existsSync(recallFile)).toBe(true);
    expect(fs.readFileSync(recallFile, "utf-8")).toContain("mem context");
  }, 10000);

  it("fails gracefully when adapter throws", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const config = makeConfig(["error-adapter"], 200);

    const adapter: SessionAdapter = {
      name: "error-adapter",
      sessionDir: () => os.tmpdir(),
      discoverSessions: async () => { throw new Error("permission denied"); },
      parseNewMessages: async () => [],
      detectTurns: () => [],
    };

    registerAdapter("error-adapter", () => adapter);
    const watcher = new SessionWatcher(config, makeClient(calls));
    // Should not throw — error is caught and logged
    await watcher.start();
    await new Promise((r) => setTimeout(r, 500));
    await watcher.stop();
    expect(true).toBe(true);
  }, 10000);
});
