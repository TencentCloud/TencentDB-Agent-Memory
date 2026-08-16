import { describe, expect, it } from "vitest";

import { createTencentDbMemoryExtension } from "../src/extension.js";
import type { MemoryClientLike, RecallBundle } from "../src/client.js";

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}

interface RecordedHandler {
  event: string;
  handler: (...args: unknown[]) => unknown;
}

function makePi() {
  const tools: RegisteredTool[] = [];
  const commands: string[] = [];
  const handlers: RecordedHandler[] = [];
  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  return {
    tools,
    commands,
    handlers,
    entries,
    pi: {
      registerTool(def: RegisteredTool) {
        tools.push(def);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.push({ event, handler });
      },
      appendEntry(customType: string, data?: unknown) {
        entries.push({ type: "custom", customType, data });
      },
    },
  };
}

function makeClient(): MemoryClientLike {
  return {
    async recall(): Promise<RecallBundle> {
      return { atomic: [], scenarios: [], core: null, warnings: [] };
    },
    async listScenarios() {
      return [];
    },
    async readCore() {
      return null;
    },
    async searchAtomic() {
      return [];
    },
    async searchConversation() {
      return [];
    },
    async captureConversation() {},
    async captureSkill() {},
    async check() {
      return 0;
    },
  };
}

const fullEnv = {
  TDAI_MEMORY_API_KEY: "sk-test",
  TDAI_MEMORY_SERVICE_ID: "service-1",
  TDAI_MEMORY_TEAM_ID: "team-1",
  TDAI_MEMORY_AGENT_ID: "agent-1",
  TDAI_MEMORY_USER_ID: "user-1",
};

describe("createTencentDbMemoryExtension", () => {
  it("registers the three tools and status command when configured", () => {
    const { pi, tools, commands, handlers } = makePi();
    const factory = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => makeClient(),
      logger: { warn() {} },
    });
    factory(pi as never);

    expect(tools.map((t) => t.name).sort()).toEqual([
      "tdai_conversation_search",
      "tdai_memory_recall",
      "tdai_memory_search",
    ]);
    expect(commands).toContain("tdai-memory-status");
    expect(handlers.map((h) => h.event)).toEqual(
      expect.arrayContaining(["before_agent_start", "agent_end", "agent_settled", "session_shutdown"]),
    );
  });

  it("registers only a disabled status command when misconfigured", () => {
    const { pi, tools, commands, handlers } = makePi();
    const factory = createTencentDbMemoryExtension({ env: {}, logger: { warn() {} } });
    factory(pi as never);

    expect(tools).toHaveLength(0);
    expect(commands).toContain("tdai-memory-status");
    expect(handlers).toHaveLength(0);
  });

  it("fails open when recall throws", async () => {
    const { pi, handlers } = makePi();
    const factory = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => ({
        ...makeClient(),
        async recall() {
          throw new Error("offline");
        },
      }),
      logger: { warn() {} },
    });
    factory(pi as never);

    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const result = await before.handler(
      { prompt: "hello", systemPrompt: "base" },
      { signal: undefined, hasUI: false, ui: {} },
    );
    expect(result).toBeUndefined();
  });

  it("injects recalled context into the system prompt", async () => {
    const { pi, handlers } = makePi();
    const factory = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => ({
        ...makeClient(),
        async recall(): Promise<RecallBundle> {
          return {
            atomic: [{ id: "m1", type: "preference", content: "Use Go" }],
            scenarios: [],
            core: null,
            warnings: [],
          };
        },
      }),
      logger: { warn() {} },
    });
    factory(pi as never);

    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const result = (await before.handler(
      { prompt: "hello", systemPrompt: "base" },
      { signal: undefined, hasUI: false, ui: {} },
    )) as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toContain("base");
    expect(result?.systemPrompt).toContain("Use Go");
  });

  it("accumulates multiple agent loops and captures the settled turn", async () => {
    const captured: Array<{ user: string; assistant: string }> = [];
    const { pi, handlers } = makePi();
    const factory = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => ({
        ...makeClient(),
        async captureConversation(turn) {
          captured.push({ user: turn.user, assistant: turn.assistant });
        },
      }),
      logger: { warn() {} },
    });
    factory(pi as never);

    const ctx = {
      signal: undefined,
      hasUI: false,
      ui: {},
      sessionManager: { getSessionId: () => "session-1" },
    };
    const before = handlers.find((h) => h.event === "before_agent_start")!;
    const agentEnd = handlers.find((h) => h.event === "agent_end")!;
    const settled = handlers.find((h) => h.event === "agent_settled")!;

    await before.handler({ prompt: "first request", systemPrompt: "base" }, ctx);
    await agentEnd.handler({
      messages: [
        { role: "user", content: [{ type: "text", text: "first request" }] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first answer" }] },
      ],
    });
    await agentEnd.handler({
      messages: [
        { role: "user", content: [{ type: "text", text: "queued follow-up" }] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final answer" }] },
      ],
    });
    await settled.handler({}, ctx);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.assistant).toBe("final answer");
    expect(captured[0]!.user).toContain("first request");
    expect(captured[0]!.user).toContain("queued follow-up");
  });

  it("recovers incomplete captures on session start", async () => {
    const captured: string[] = [];
    const { pi, handlers, entries } = makePi();
    const factory = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => ({
        ...makeClient(),
        async captureConversation(turn) {
          captured.push(turn.assistant);
        },
      }),
      logger: { warn() {} },
    });
    factory(pi as never);

    entries.push({
      type: "custom",
      customType: "tdai-memory-captured",
      data: {
        version: 1,
        key: "key-1",
        l0: false,
        skill: true,
        turn: { sessionId: "pi:s", user: "hi", assistant: "recovered", skillMessages: [], capturedAtMs: 1 },
      },
    });

    const ctx = {
      signal: undefined,
      hasUI: false,
      ui: {},
      sessionManager: { getSessionId: () => "s", getBranch: () => entries, getEntries: () => entries },
    };
    const sessionStart = handlers.find((h) => h.event === "session_start")!;
    await sessionStart.handler({}, ctx);

    expect(captured).toContain("recovered");
  });

  it("retries only the failed pipeline on recovery", async () => {
    let l0Calls = 0;
    let skillCalls = 0;
    const { pi, handlers, entries } = makePi();
    const factory = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => ({
        ...makeClient(),
        async captureConversation() {
          l0Calls += 1;
        },
        async captureSkill() {
          skillCalls += 1;
          if (skillCalls === 1) throw new Error("boom");
        },
      }),
      logger: { warn() {} },
    });
    factory(pi as never);

    entries.push({
      type: "custom",
      customType: "tdai-memory-captured",
      data: {
        version: 1,
        key: "key-1",
        l0: true,
        skill: false,
        turn: { sessionId: "pi:s", user: "hi", assistant: "recovered", skillMessages: [], capturedAtMs: 1 },
      },
    });

    const ctx = {
      signal: undefined,
      hasUI: false,
      ui: {},
      sessionManager: { getSessionId: () => "s", getBranch: () => entries, getEntries: () => entries },
    };
    const sessionStart = handlers.find((h) => h.event === "session_start")!;
    await sessionStart.handler({}, ctx);

    expect(l0Calls).toBe(0);
    expect(skillCalls).toBe(1);
  });

  it("treats unknown marker versions as L0-written", async () => {
    let l0Calls = 0;
    const { pi, handlers, entries } = makePi();
    const factory = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => ({
        ...makeClient(),
        async captureConversation() {
          l0Calls += 1;
        },
      }),
      logger: { warn() {} },
    });
    factory(pi as never);

    entries.push({
      type: "custom",
      customType: "tdai-memory-captured",
      data: { version: 0, key: "old-key", l0: false, skill: false },
    });

    const ctx = {
      signal: undefined,
      hasUI: false,
      ui: {},
      sessionManager: { getSessionId: () => "s", getBranch: () => entries, getEntries: () => entries },
    };
    const sessionStart = handlers.find((h) => h.event === "session_start")!;
    await sessionStart.handler({}, ctx);

    expect(l0Calls).toBe(0);
  });

  it("survives a capture failure across a reload loop", async () => {
    const l0Calls: string[] = [];
    const skillCalls: string[] = [];

    // First process: L0 succeeds, Skill fails.
    const first = makePi();
    const factory1 = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => ({
        ...makeClient(),
        async captureConversation(turn) {
          l0Calls.push(turn.assistant);
        },
        async captureSkill(turn) {
          skillCalls.push(turn.assistant);
          throw new Error("skill pipeline down");
        },
      }),
      logger: { warn() {} },
    });
    factory1(first.pi as never);

    const ctx1 = {
      signal: undefined,
      hasUI: false,
      ui: {},
      sessionManager: { getSessionId: () => "s", getBranch: () => [], getEntries: () => [] },
    };
    await first.handlers.find((h) => h.event === "session_start")!.handler({}, ctx1);
    await first.handlers.find((h) => h.event === "before_agent_start")!.handler(
      { prompt: "hi", systemPrompt: "base" },
      ctx1,
    );
    await first.handlers.find((h) => h.event === "agent_end")!.handler({
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hello" }] },
      ],
    });
    await first.handlers.find((h) => h.event === "agent_settled")!.handler({}, ctx1);

    expect(l0Calls).toEqual(["hello"]);
    expect(skillCalls).toEqual(["hello"]);
    expect(first.entries.length).toBeGreaterThan(0);

    // Reload: a fresh extension instance restores the marker from the session.
    const second = makePi();
    second.entries.push(...first.entries);
    const factory2 = createTencentDbMemoryExtension({
      env: fullEnv,
      clientFactory: () => ({
        ...makeClient(),
        async captureConversation(turn) {
          l0Calls.push(turn.assistant);
        },
        async captureSkill(turn) {
          skillCalls.push(turn.assistant);
        },
      }),
      logger: { warn() {} },
    });
    factory2(second.pi as never);

    const ctx2 = {
      signal: undefined,
      hasUI: false,
      ui: {},
      sessionManager: {
        getSessionId: () => "s",
        getBranch: () => second.entries,
        getEntries: () => second.entries,
      },
    };
    await second.handlers.find((h) => h.event === "session_start")!.handler({}, ctx2);

    expect(l0Calls).toEqual(["hello"]);
    expect(skillCalls).toEqual(["hello", "hello"]);
  });
});
