import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  addConversation: vi.fn(),
  appendEntry: vi.fn(),
  createClients: vi.fn(),
  createSessionMemoryClient: vi.fn(),
  enqueueCapture: vi.fn(),
  flushOutbox: vi.fn(),
  injectRecall: vi.fn((systemPrompt: string, recalled: string) => `${systemPrompt}\n\n${recalled}`),
  loadConfig: vi.fn(),
  recallMemory: vi.fn(),
  runSetup: vi.fn(),
}));

vi.mock("../src/clients.js", () => ({
  createClients: mocks.createClients,
  createSessionMemoryClient: mocks.createSessionMemoryClient,
}));
vi.mock("../src/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/outbox.js", () => ({
  enqueueCapture: mocks.enqueueCapture,
  flushOutbox: mocks.flushOutbox,
}));
vi.mock("../src/recall.js", () => ({
  injectRecall: mocks.injectRecall,
  recallMemory: mocks.recallMemory,
}));
vi.mock("../src/setup.js", () => ({ runSetup: mocks.runSetup }));

import tdaiMemoryExtension from "../src/index.js";

type Handler = (...args: any[]) => Promise<unknown> | unknown;
type RegisteredTool = { name: string; execute: Handler; promptSnippet?: string };
type RegisteredCommand = { handler: Handler };

const config: LoadedConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:8420",
  serviceId: "default",
  teamId: "team-test",
  agentId: "agent-test",
  userId: "user-test",
  userKey: "sk-mem-test",
  gatewayApiKey: "gateway-test",
  timeoutMs: 1_000,
  rejectUnauthorized: true,
  captureTools: false,
  sources: [],
  userKeySource: "test",
  gatewayApiKeySource: "test",
  recall: { enabled: true, deadlineMs: 3_000, l0Limit: 4, l1Limit: 6, l2Limit: 2, maxChars: 12000 },
};

function installExtension(): {
  handlers: Map<string, Handler>;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  ctx: Record<string, unknown>;
} {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const ctx = {
    cwd: "C:\\workspace",
    hasUI: true,
    isProjectTrusted: () => true,
    reload: vi.fn(),
    sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  const pi = {
    appendEntry: mocks.appendEntry,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
  };
  tdaiMemoryExtension(pi as unknown as ExtensionAPI);
  return { handlers, tools, commands, ctx };
}

async function call(handlers: Map<string, Handler>, event: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`Missing ${event} handler`);
  return handler(...(args as never[]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadConfig.mockResolvedValue({ ok: true, config });
  mocks.createClients.mockReturnValue({ memory: { name: "recall-client" } });
  mocks.createSessionMemoryClient.mockReturnValue({ addConversation: mocks.addConversation });
  mocks.enqueueCapture.mockResolvedValue({ id: "capture-1" });
  mocks.flushOutbox.mockResolvedValue({ delivered: 1, pending: 0, invalid: 0, dead: 0 });
  mocks.recallMemory.mockResolvedValue({
    content: "<tdai_recalled_memory>context</tdai_recalled_memory>",
    availableLayers: ["L0 conversation"],
    failedLayers: [],
    timedOutLayers: [],
  });
  mocks.runSetup.mockResolvedValue({ ok: true, configPath: "C:\\agent\\tdai-memory.json", createdAgent: false });
  mocks.addConversation.mockResolvedValue({ accepted_ids: ["msg-1"] });
});

describe("Pi extension lifecycle", () => {
  it("reloads Pi after interactive setup activates a verified global configuration", async () => {
    const { commands, ctx } = installExtension();
    const setup = commands.get("tdai-memory-setup");

    await setup?.handler("", ctx);

    expect(mocks.runSetup).toHaveBeenCalledWith(ctx);
    expect(mocks.loadConfig).toHaveBeenCalledWith({ cwd: "C:\\workspace", projectTrusted: true });
    expect((ctx.reload as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      "Memory setup complete. The extension was reloaded.",
      "info",
    );
  });

  it("does not reload Pi when setup is cancelled or fails", async () => {
    mocks.runSetup.mockResolvedValue({ ok: false, cancelled: true, message: "Memory setup cancelled." });
    const { commands, ctx } = installExtension();
    const setup = commands.get("tdai-memory-setup");

    await setup?.handler("", ctx);

    expect((ctx.reload as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
    expect((ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify).toHaveBeenCalledWith(
      "Memory setup cancelled.",
      "warning",
    );
  });

  it("registers the two read-only memory search tools and fails open before configuration", async () => {
    const { tools, ctx } = installExtension();
    const structured = tools.get("tdai_memory_search");
    const conversation = tools.get("tdai_conversation_search");
    expect(structured?.promptSnippet).toContain("at most 3 times total per turn");
    expect(conversation?.promptSnippet).toContain("at most 3 times total per turn");
    const result = await structured?.execute("call-1", { query: "preference" }, undefined, undefined, ctx);
    expect(result).toEqual({
      content: [{
        type: "text",
        text: '<tdai_untrusted_memory trust="untrusted" purpose="reference-only">\nMemory not configured. Continue without memory.\n</tdai_untrusted_memory>',
      }],
      details: {},
    });
    expect(mocks.createClients).not.toHaveBeenCalled();
  });

  it("recalls before the run and persists the final successful answer after settlement", async () => {
    const { handlers, ctx } = installExtension();
    await call(handlers, "session_start", {}, ctx);

    const before = await call(
      handlers,
      "before_agent_start",
      { prompt: "How should we install packages?", systemPrompt: "Base instructions" },
      ctx,
    );
    expect(before).toEqual({ systemPrompt: "Base instructions\n\n<tdai_recalled_memory>context</tdai_recalled_memory>" });

    await call(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Use pnpm." }] }],
    });
    await call(handlers, "agent_settled", {}, ctx);

    expect(mocks.enqueueCapture).toHaveBeenCalledWith(config, "pi-session-1-root", [
      { role: "user", content: "How should we install packages?" },
      { role: "assistant", content: "Use pnpm." },
    ]);
    expect(mocks.flushOutbox).toHaveBeenCalled();
    expect(mocks.appendEntry).toHaveBeenCalledWith(
      "tdai-memory/capture-queued@1",
      expect.objectContaining({ captureId: "capture-1", sessionId: "pi-session-1-root" }),
    );
    expect(mocks.addConversation).not.toHaveBeenCalledWith({
      messages: [
        { role: "user", content: "How should we install packages?" },
        { role: "assistant", content: "Use pnpm." },
      ],
    });
  });

  it("marks recall as partial when a slow layer reaches the global deadline", async () => {
    mocks.recallMemory.mockResolvedValue({
      content: "<tdai_recalled_memory>fast context</tdai_recalled_memory>",
      availableLayers: ["L1 atomic"],
      failedLayers: [],
      timedOutLayers: ["L0 conversation"],
    });
    const { handlers, ctx } = installExtension();
    await call(handlers, "session_start", {}, ctx);

    await call(handlers, "before_agent_start", { prompt: "Use context", systemPrompt: "Base" }, ctx);

    expect(((ctx.ui as { setStatus: ReturnType<typeof vi.fn> }).setStatus)).toHaveBeenCalledWith(
      "tdai-memory",
      "memory: recalled (partial)",
    );
  });

  it("returns control to Pi so the answer model can run when Memory never settles", async () => {
    const offlineConfig = {
      ...config,
      recall: { ...config.recall, deadlineMs: 100 },
    };
    mocks.loadConfig.mockResolvedValue({ ok: true, config: offlineConfig });
    mocks.flushOutbox.mockRejectedValue(new Error("Memory is offline"));
    mocks.recallMemory.mockReturnValue(new Promise(() => undefined));
    mocks.createClients.mockReturnValue({
      memory: {
        searchAtomic: vi.fn(() => new Promise(() => undefined)),
        searchConversation: vi.fn(() => new Promise(() => undefined)),
      },
    });
    vi.useFakeTimers();
    try {
      const answerModel = vi
        .fn()
        .mockResolvedValueOnce({ toolName: "tdai_memory_search", params: { query: "preference" } })
        .mockResolvedValueOnce("model answer");
      const { handlers, tools, ctx } = installExtension();
      await call(handlers, "session_start", {}, ctx);

      const beforePromise = call(
        handlers,
        "before_agent_start",
        { prompt: "Answer without memory", systemPrompt: "Base instructions" },
        ctx,
      );
      let beforeSettled = false;
      void beforePromise.then(() => {
        beforeSettled = true;
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(beforeSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const before = await beforePromise;

      const systemPrompt =
        before && typeof before === "object" && "systemPrompt" in before
          ? String((before as { systemPrompt: unknown }).systemPrompt)
          : "Base instructions";
      const firstModelResult = await answerModel(systemPrompt);
      const tool = tools.get(firstModelResult.toolName);
      const toolPromise = tool?.execute("call-offline", firstModelResult.params, undefined, undefined, ctx);
      await vi.advanceTimersByTimeAsync(100);
      const toolResult = await toolPromise;
      await answerModel(systemPrompt, toolResult);

      expect(before).toBeUndefined();
      expect(answerModel).toHaveBeenNthCalledWith(1, "Base instructions");
      expect(answerModel).toHaveBeenNthCalledWith(
        2,
        "Base instructions",
        expect.objectContaining({
          content: [expect.objectContaining({ text: expect.stringContaining("Continue without memory.") })],
        }),
      );
      expect(((ctx.ui as { setStatus: ReturnType<typeof vi.fn> }).setStatus)).toHaveBeenCalledWith(
        "tdai-memory",
        "memory: recall unavailable",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not store an earlier response when the final run fails", async () => {
    const { handlers, ctx } = installExtension();
    await call(handlers, "session_start", {}, ctx);
    await call(handlers, "before_agent_start", { prompt: "Remember this", systemPrompt: "Base" }, ctx);
    await call(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old answer" }] }],
    });
    await call(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "error", content: [{ type: "text", text: "partial answer" }] }],
    });
    await call(handlers, "agent_settled", {}, ctx);

    expect(mocks.addConversation).not.toHaveBeenCalled();
    expect(mocks.appendEntry).not.toHaveBeenCalled();
  });

  it("captures only successful tool evidence when explicitly enabled", async () => {
    mocks.loadConfig.mockResolvedValue({ ok: true, config: { ...config, captureTools: true } });
    const { handlers, ctx } = installExtension();
    await call(handlers, "session_start", {}, ctx);
    await call(handlers, "before_agent_start", { prompt: "Inspect files", systemPrompt: "Base" }, ctx);
    await call(handlers, "tool_result", { toolName: "read", isError: false, content: [{ type: "text", text: "safe evidence" }] }, ctx);
    await call(handlers, "tool_result", { toolName: "bash", isError: true, content: [{ type: "text", text: "failed output" }] }, ctx);
    await call(handlers, "agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
    await call(handlers, "agent_settled", {}, ctx);
    expect(mocks.enqueueCapture).toHaveBeenCalledWith(
      expect.objectContaining({ captureTools: true }),
      "pi-session-1-root",
      expect.arrayContaining([{ role: "system", content: "[tool:read]\nsafe evidence" }]),
    );
    const captured = mocks.enqueueCapture.mock.calls[0]?.[2] ?? [];
    expect(captured).not.toContainEqual(expect.objectContaining({ content: expect.stringContaining("failed output") }));
  });

  it("does not capture results returned by either memory search tool", async () => {
    mocks.loadConfig.mockResolvedValue({ ok: true, config: { ...config, captureTools: true } });
    const { handlers, ctx } = installExtension();
    await call(handlers, "session_start", {}, ctx);
    await call(handlers, "before_agent_start", { prompt: "Recall and inspect", systemPrompt: "Base" }, ctx);
    await call(handlers, "tool_result", {
      toolName: "tdai_memory_search",
      isError: false,
      content: [{ type: "text", text: "structured memory result" }],
    }, ctx);
    await call(handlers, "tool_result", {
      toolName: "tdai_conversation_search",
      isError: false,
      content: [{ type: "text", text: "conversation memory result" }],
    }, ctx);
    await call(handlers, "tool_result", {
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "fresh file evidence" }],
    }, ctx);
    await call(handlers, "agent_end", {
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }],
    });
    await call(handlers, "agent_settled", {}, ctx);

    const captured = mocks.enqueueCapture.mock.calls[0]?.[2] ?? [];
    expect(captured).toContainEqual({ role: "system", content: "[tool:read]\nfresh file evidence" });
    expect(captured).not.toContainEqual(expect.objectContaining({ content: expect.stringContaining("structured memory result") }));
    expect(captured).not.toContainEqual(expect.objectContaining({ content: expect.stringContaining("conversation memory result") }));
  });

  it("creates a durable memory branch only after navigating to an unmarked tree branch", async () => {
    const { handlers, ctx } = installExtension();
    await call(handlers, "session_start", {}, ctx);
    await call(handlers, "session_tree", {}, ctx);

    expect(mocks.appendEntry).toHaveBeenCalledWith(
      "tdai-memory/branch@1",
      expect.objectContaining({ branchId: expect.stringMatching(/^branch-[A-Za-z0-9-]+$/) }),
    );

    await call(handlers, "before_agent_start", { prompt: "Separate branch", systemPrompt: "Base" }, ctx);
    await call(handlers, "agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
    await call(handlers, "agent_settled", {}, ctx);
    expect(mocks.enqueueCapture).toHaveBeenCalledWith(
      config,
      expect.stringMatching(/^pi-session-1-branch-[A-Za-z0-9-]+$/),
      expect.any(Array),
    );
  });
});
