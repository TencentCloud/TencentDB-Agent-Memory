import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type {
  AtomicMemory,
  CaptureTurn,
  ConversationMemory,
  MemoryClientLike,
  RecallBundle,
} from "../src/client.js";
import { turnKey } from "../src/client.js";
import { createTencentDbMemoryExtension } from "../src/extension.js";

type Handler = (event: any, context: any) => any;

class FakePi {
  readonly handlers = new Map<string, Handler>();
  readonly tools = new Map<string, Record<string, any>>();
  readonly commands = new Map<string, Record<string, any>>();
  readonly entries: Array<{ customType: string; data: unknown }> = [];

  on(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  registerTool(tool: Record<string, any>): void {
    this.tools.set(String(tool.name), tool);
  }

  registerCommand(name: string, command: Record<string, any>): void {
    this.commands.set(name, command);
  }

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({ customType, data });
  }
}

const validEnv = {
  TDAI_MEMORY_ENDPOINT: "https://memory.example.com",
  TDAI_MEMORY_API_KEY: "secret",
  TDAI_MEMORY_SERVICE_ID: "service-1",
  TDAI_MEMORY_TEAM_ID: "team-1",
  TDAI_MEMORY_AGENT_ID: "agent-1",
  TDAI_MEMORY_USER_ID: "user-1",
};

const context = {
  hasUI: false,
  signal: undefined,
  ui: {
    setStatus: vi.fn(),
    notify: vi.fn(),
  },
  sessionManager: {
    getSessionId: () => "session-1",
    getEntries: () => [],
  },
};

function client(overrides: Partial<MemoryClientLike> = {}): MemoryClientLike {
  return {
    recall: async (): Promise<RecallBundle> => ({
      atomic: [],
      scenarios: [],
      core: null,
      warnings: [],
    }),
    captureTurn: async () => undefined,
    searchAtomic: async (): Promise<AtomicMemory[]> => [],
    searchConversation: async (): Promise<ConversationMemory[]> => [],
    check: async () => 0,
    ...overrides,
  };
}

function install(memoryClient: MemoryClientLike): FakePi {
  const pi = new FakePi();
  createTencentDbMemoryExtension({
    env: validEnv,
    clientFactory: () => memoryClient,
    logger: { warn: vi.fn() },
  })(pi as unknown as ExtensionAPI);
  return pi;
}

describe("Pi extension lifecycle", () => {
  it("injects bounded recall and captures the completed turn after settlement", async () => {
    const captureTurn = vi.fn(async (_turn: CaptureTurn, _signal?: AbortSignal) => undefined);
    const pi = install(
      client({
        recall: async () => ({
          atomic: [{ id: "m1", type: "preference", content: "Keep answers concise" }],
          scenarios: [],
          core: null,
          warnings: [],
        }),
        captureTurn,
      }),
    );

    const before = await pi.handlers.get("before_agent_start")?.(
      { prompt: "What style should I use?", systemPrompt: "base" },
      context,
    );
    expect(before.systemPrompt).toContain("Keep answers concise");

    await pi.handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Use a concise style." }],
          },
        ],
      },
      context,
    );
    await pi.handlers.get("agent_settled")?.({}, context);

    expect(captureTurn).toHaveBeenCalledTimes(1);
    expect(pi.entries).toHaveLength(1);
    expect(captureTurn.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "pi:session-1",
      user: "What style should I use?",
      assistant: "Use a concise style.",
    });
  });

  it("deduplicates repeated delivery of the same completed turn", async () => {
    const captureTurn = vi.fn(async (_turn: CaptureTurn, _signal?: AbortSignal) => undefined);
    const pi = install(client({ captureTurn }));
    const run = async () => {
      await pi.handlers.get("before_agent_start")?.(
        { prompt: "same", systemPrompt: "base" },
        context,
      );
      await pi.handlers.get("agent_end")?.(
        {
          messages: [
            {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "same answer" }],
            },
          ],
        },
        context,
      );
      await pi.handlers.get("agent_settled")?.({}, context);
    };

    await run();
    await run();

    expect(captureTurn).toHaveBeenCalledTimes(1);
  });

  it("restores successful capture markers from the Pi session", async () => {
    const captureTurn = vi.fn(async (_turn: CaptureTurn, _signal?: AbortSignal) => undefined);
    const pi = install(client({ captureTurn }));
    const restoredContext = {
      ...context,
      sessionManager: {
        getSessionId: () => "session-1",
        getEntries: () => [
          {
            type: "custom",
            customType: "tdai-memory-captured",
            data: {
              key: turnKey({
                sessionId: "pi:session-1",
                user: "same",
                assistant: "same answer",
              }),
            },
          },
        ],
      },
    };

    await pi.handlers.get("session_start")?.({}, restoredContext);
    await pi.handlers.get("before_agent_start")?.(
      { prompt: "same", systemPrompt: "base" },
      restoredContext,
    );
    await pi.handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "same answer" }],
          },
        ],
      },
      restoredContext,
    );
    await pi.handlers.get("agent_settled")?.({}, restoredContext);

    expect(captureTurn).not.toHaveBeenCalled();
  });

  it("fails open when recall and capture are unavailable", async () => {
    const pi = install(
      client({
        recall: async () => {
          throw new Error("offline");
        },
        captureTurn: async () => {
          throw new Error("offline");
        },
      }),
    );

    await expect(
      pi.handlers.get("before_agent_start")?.(
        { prompt: "continue working", systemPrompt: "base" },
        context,
      ),
    ).resolves.toBeUndefined();
    await pi.handlers.get("agent_end")?.(
      {
        messages: [
          {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "work still completed" }],
          },
        ],
      },
      context,
    );
    await expect(pi.handlers.get("agent_settled")?.({}, context)).resolves.toBeUndefined();
  });

  it("registers native memory and conversation search tools", async () => {
    const searchAtomic = vi.fn(async () => [
      { id: "m1", type: "fact", content: "A remembered fact" },
    ]);
    const searchConversation = vi.fn(async () => [
      { role: "user" as const, content: "Earlier evidence" },
    ]);
    const pi = install(client({ searchAtomic, searchConversation }));

    const memoryTool = pi.tools.get("tdai_memory_search")!;
    const memoryResult = await memoryTool.execute("call-1", { query: "fact" }, undefined);
    expect(memoryResult.content[0].text).toContain("A remembered fact");

    const conversationTool = pi.tools.get("tdai_conversation_search")!;
    const conversationResult = await conversationTool.execute(
      "call-2",
      { query: "evidence", sessionOnly: true },
      undefined,
      undefined,
      context,
    );
    expect(conversationResult.content[0].text).toContain("Earlier evidence");
    expect(searchConversation).toHaveBeenCalledWith("evidence", 5, "pi:session-1", undefined);
  });

  it("loads only the status command when required configuration is missing", () => {
    const pi = new FakePi();
    createTencentDbMemoryExtension({ env: {} })(pi as unknown as ExtensionAPI);
    expect(pi.commands.has("tdai-memory-status")).toBe(true);
    expect(pi.handlers.size).toBe(0);
    expect(pi.tools.size).toBe(0);
  });
});
