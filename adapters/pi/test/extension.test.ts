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
  return {
    tools,
    commands,
    handlers,
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
});
