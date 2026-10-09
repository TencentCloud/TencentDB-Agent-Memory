import { describe, expect, it } from "vitest";
import { createMemoryAgent } from "../memory-agent.js";
import { createMockDriver } from "../drivers/mock.js";
import type {
  CaptureRequest,
  CaptureResponse,
  GatewayClientLike,
  GatewaySupervisorLike,
  MemoryPaths,
  RecallResponse,
} from "../types.js";

describe("MemoryAgent", () => {
  it("recalls, injects memory into the SDK prompt, streams, and captures original prompt", async () => {
    const gateway = new FakeGateway({ context: "User prefers TypeScript." });
    const supervisor = new FakeSupervisor();
    const seenPrompts: string[] = [];
    const agent = createMemoryAgent({
      agentSdkName: "codex-sdk",
      driver: createMockDriver({
        responder: (input) => {
          seenPrompts.push(input.prompt);
          return "TDAI_AGENT_SDK_OK";
        },
      }),
      gateway,
      supervisor,
      sessionKey: "session:1",
      userId: "user:1",
    });

    const session = await agent.startSession();
    const result = await session.run({ prompt: "What should I use?" });

    expect(supervisor.ensureCalls).toBe(2);
    expect(result.text).toBe("TDAI_AGENT_SDK_OK");
    expect(seenPrompts[0]).toContain("# Long-term Memory Context");
    expect(seenPrompts[0]).toContain("User prefers TypeScript.");
    expect(gateway.recallCalls[0]).toEqual({ query: "What should I use?", sessionKey: "session:1", userId: "user:1" });
    expect(gateway.captureCalls[0]).toMatchObject({
      userContent: "What should I use?",
      assistantContent: "TDAI_AGENT_SDK_OK",
      sessionKey: "session:1",
      userId: "user:1",
    });
    expect(gateway.captureCalls[0].startedAt).toEqual(expect.any(Number));
    expect(gateway.captureCalls[0].messages).toEqual([
      expect.objectContaining({ role: "user", content: "What should I use?", timestamp: expect.any(Number) }),
      expect.objectContaining({ role: "assistant", content: "TDAI_AGENT_SDK_OK", timestamp: expect.any(Number) }),
    ]);
    await session.end();
    expect(gateway.endCalls).toEqual([{ sessionKey: "session:1", userId: "user:1" }]);
  });

  it("leaves the prompt unchanged when recall returns no context", async () => {
    const gateway = new FakeGateway({ context: "" });
    const supervisor = new FakeSupervisor();
    let prompt = "";
    const agent = createMemoryAgent({
      agentSdkName: "codex-sdk",
      driver: createMockDriver({ responder: (input) => {
        prompt = input.prompt;
        return "ok";
      } }),
      gateway,
      supervisor,
    });

    const session = await agent.startSession({ sessionKey: "session:empty" });
    await session.run({ prompt: "plain" });

    expect(prompt).toBe("plain");
  });

  it("is fail-open by default for capture errors", async () => {
    const gateway = new FakeGateway({ context: "", failCapture: true });
    const agent = createMemoryAgent({
      agentSdkName: "codex-sdk",
      driver: createMockDriver({ responder: () => "ok" }),
      gateway,
      supervisor: new FakeSupervisor(),
    });

    const session = await agent.startSession({ sessionKey: "session:fail-open" });
    const result = await session.run({ prompt: "q" });

    expect(result.text).toBe("ok");
    expect(result.events.some((event) => event.type === "memory.error" && event.phase === "capture")).toBe(true);
  });

  it("throws when strict mode is enabled", async () => {
    const gateway = new FakeGateway({ context: "", failRecall: true });
    const agent = createMemoryAgent({
      agentSdkName: "codex-sdk",
      driver: createMockDriver({ responder: () => "ok" }),
      gateway,
      supervisor: new FakeSupervisor(),
      strict: true,
    });

    const session = await agent.startSession({ sessionKey: "session:strict" });
    await expect(session.run({ prompt: "q" })).rejects.toThrow("recall failed");
  });
});

class FakeSupervisor implements GatewaySupervisorLike {
  endpoints = { gatewayUrl: "http://127.0.0.1:1" };
  paths: MemoryPaths = {
    rootDir: "/tmp/root",
    configPath: "/tmp/root/tdai-gateway.yaml",
    dataDir: "/tmp/root/data",
    logDir: "/tmp/root/logs",
    runtimeDir: "/tmp/root/runtime",
  };
  ensureCalls = 0;
  closeCalls = 0;

  async ensureRunning(): Promise<void> {
    this.ensureCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeGateway implements GatewayClientLike {
  recallCalls: Array<{ query: string; sessionKey: string; userId?: string }> = [];
  captureCalls: CaptureRequest[] = [];
  endCalls: Array<{ sessionKey: string; userId?: string }> = [];

  constructor(private readonly options: {
    context: string;
    failRecall?: boolean;
    failCapture?: boolean;
  }) {}

  async health() {
    return { status: "ok" };
  }

  async recall(request: { query: string; sessionKey: string; userId?: string }): Promise<RecallResponse> {
    if (this.options.failRecall) throw new Error("recall failed");
    this.recallCalls.push(request);
    return { context: this.options.context, strategy: "hybrid", memoryCount: this.options.context ? 1 : 0 };
  }

  async capture(request: CaptureRequest): Promise<CaptureResponse> {
    if (this.options.failCapture) throw new Error("capture failed");
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
