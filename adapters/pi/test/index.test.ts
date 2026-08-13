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

import tdaiMemoryExtension from "../src/index.js";

type Handler = (...args: never[]) => Promise<unknown> | unknown;

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
  recall: { enabled: true, l0Limit: 4, l1Limit: 6, l2Limit: 2, maxChars: 12000 },
};

function installExtension(): { handlers: Map<string, Handler>; ctx: Record<string, unknown> } {
  const handlers = new Map<string, Handler>();
  const ctx = {
    cwd: "C:\\workspace",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
  const pi = {
    appendEntry: mocks.appendEntry,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: vi.fn(),
  };
  tdaiMemoryExtension(pi as unknown as ExtensionAPI);
  return { handlers, ctx };
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
  mocks.flushOutbox.mockResolvedValue({ delivered: 1, pending: 0, invalid: 0 });
  mocks.recallMemory.mockResolvedValue({
    content: "<tdai_recalled_memory>context</tdai_recalled_memory>",
    availableLayers: ["L0 conversation"],
    failedLayers: [],
  });
  mocks.addConversation.mockResolvedValue({ accepted_ids: ["msg-1"] });
});

describe("Pi extension lifecycle", () => {
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
