import { describe, expect, it } from "vitest";
import { withClaudeCodeMemory, withCodexMemory } from "../index.js";
import type {
  CaptureRequest,
  CaptureResponse,
  GatewayClientLike,
  GatewaySupervisorLike,
  MemoryPaths,
  RecallResponse,
} from "../types.js";

describe("SDK memory wrappers", () => {
  it("wraps a Codex client while preserving client and thread shape", async () => {
    const gateway = new FakeGateway({ context: "Use the existing Codex client." });
    const supervisor = new FakeSupervisor();
    const rawThread = new FakeCodexThread();
    const rawClient = new FakeCodexClient(rawThread);
    const memoryCodex = withCodexMemory(rawClient, {
      gateway,
      supervisor,
      sessionKey: "session:codex-wrapper",
      userId: "user:wrapper",
    });

    expect(memoryCodex.unwrap()).toBe(rawClient);
    expect(memoryCodex.rawClient).toBe(rawClient);
    expect(memoryCodex.passthrough()).toBe("raw-client");

    const thread = await memoryCodex.startThread({ model: "test-model" });
    expect(thread.unwrap()).toBe(rawThread);
    expect(thread.rawThread).toBe(rawThread);
    expect(thread.utility()).toBe("raw-thread");

    const events = [];
    for await (const event of thread.runStreamed("What should I do?")) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "item", item: { type: "agent_message", text: "wrapped response" } }]);
    expect(rawClient.threadOptions).toEqual([{ model: "test-model" }]);
    expect(rawThread.prompts[0]).toContain("# Long-term Memory Context");
    expect(rawThread.prompts[0]).toContain("Use the existing Codex client.");
    expect(gateway.recallCalls[0]).toEqual({
      query: "What should I do?",
      sessionKey: "session:codex-wrapper",
      userId: "user:wrapper",
    });
    expect(gateway.captureCalls[0]).toMatchObject({
      userContent: "What should I do?",
      assistantContent: "wrapped response",
      sessionKey: "session:codex-wrapper",
      userId: "user:wrapper",
    });
    expect(gateway.captureCalls[0].startedAt).toEqual(expect.any(Number));

    await thread.endMemorySession();
    await memoryCodex.close();
    expect(gateway.endCalls).toEqual([{ sessionKey: "session:codex-wrapper", userId: "user:wrapper" }]);
    expect(supervisor.closeCalls).toBe(0);
  });

  it("wraps Claude Code query and captures L0 from the original prompt", async () => {
    const gateway = new FakeGateway({ context: "Prefer TypeScript wrappers." });
    const supervisor = new FakeSupervisor();
    const prompts: string[] = [];
    const memoryClaude = withClaudeCodeMemory({
      query: ({ prompt }) => {
        prompts.push(prompt);
        return [{ type: "result", result: "claude wrapped response" }];
      },
    }, {
      gateway,
      supervisor,
      sessionKey: "session:claude-wrapper",
      userId: "user:wrapper",
    });

    const result = [];
    for await (const event of memoryClaude.query({ prompt: "How should this work?" })) {
      result.push(event);
    }

    expect(result).toEqual([{ type: "result", result: "claude wrapped response" }]);
    expect(memoryClaude.unwrap()).toBe(memoryClaude.rawQuery);
    expect(prompts[0]).toContain("# Long-term Memory Context");
    expect(prompts[0]).toContain("Prefer TypeScript wrappers.");
    expect(gateway.captureCalls[0]).toMatchObject({
      userContent: "How should this work?",
      assistantContent: "claude wrapped response",
      sessionKey: "session:claude-wrapper",
      userId: "user:wrapper",
    });
    expect(gateway.captureCalls[0].startedAt).toEqual(expect.any(Number));
  });
});

class FakeCodexClient {
  threadOptions: unknown[] = [];

  constructor(private readonly thread: FakeCodexThread) {}

  async startThread(options: unknown) {
    this.threadOptions.push(options);
    return this.thread;
  }

  passthrough() {
    return "raw-client";
  }
}

class FakeCodexThread {
  prompts: string[] = [];

  async *runStreamed(prompt: string) {
    this.prompts.push(prompt);
    yield { type: "item", item: { type: "agent_message", text: "wrapped response" } };
  }

  utility() {
    return "raw-thread";
  }
}

class FakeSupervisor implements GatewaySupervisorLike {
  endpoints = { gatewayUrl: "http://127.0.0.1:1" };
  paths: MemoryPaths = {
    rootDir: "/tmp/root",
    configPath: "/tmp/root/tdai-gateway.yaml",
    dataDir: "/tmp/root/data",
    logDir: "/tmp/root/logs",
    runtimeDir: "/tmp/root/runtime",
  };
  closeCalls = 0;

  async ensureRunning(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeGateway implements GatewayClientLike {
  recallCalls: Array<{ query: string; sessionKey: string; userId?: string }> = [];
  captureCalls: CaptureRequest[] = [];
  endCalls: Array<{ sessionKey: string; userId?: string }> = [];

  constructor(private readonly options: { context: string }) {}

  async health() {
    return { status: "ok" };
  }

  async recall(request: { query: string; sessionKey: string; userId?: string }): Promise<RecallResponse> {
    this.recallCalls.push(request);
    return { context: this.options.context, strategy: "hybrid", memoryCount: this.options.context ? 1 : 0 };
  }

  async capture(request: CaptureRequest): Promise<CaptureResponse> {
    this.captureCalls.push(request);
    return { l0Recorded: 2, schedulerNotified: true };
  }

  async endSession(request: { sessionKey: string; userId?: string }) {
    this.endCalls.push(request);
    return { flushed: true };
  }

  async searchMemories() {
    return { results: "", total: 0, strategy: "hybrid" };
  }

  async searchConversations() {
    return { results: "", total: 0 };
  }
}
