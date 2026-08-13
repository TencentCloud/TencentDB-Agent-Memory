import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadedConfig } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  addConversation: vi.fn(),
  appendEntry: vi.fn(),
  createClients: vi.fn(),
  createSessionMemoryClient: vi.fn(),
  injectRecall: vi.fn((systemPrompt: string, recalled: string) => `${systemPrompt}\n\n${recalled}`),
  loadConfig: vi.fn(),
  recallConversation: vi.fn(),
}));

vi.mock("../src/clients.js", () => ({
  createClients: mocks.createClients,
  createSessionMemoryClient: mocks.createSessionMemoryClient,
}));
vi.mock("../src/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/recall.js", () => ({
  injectRecall: mocks.injectRecall,
  recallConversation: mocks.recallConversation,
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
  sources: [],
  userKeySource: "test",
  gatewayApiKeySource: "test",
};

function installExtension(): { handlers: Map<string, Handler>; ctx: Record<string, unknown> } {
  const handlers = new Map<string, Handler>();
  const ctx = {
    cwd: "C:\\workspace",
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "session-1" },
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
  mocks.recallConversation.mockResolvedValue("<tdai_recalled_memory>context</tdai_recalled_memory>");
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

    expect(mocks.addConversation).toHaveBeenCalledWith({
      messages: [
        { role: "user", content: "How should we install packages?" },
        { role: "assistant", content: "Use pnpm." },
      ],
    });
    expect(mocks.appendEntry).toHaveBeenCalledWith(
      "tdai-memory/capture-result@1",
      expect.objectContaining({ acceptedIds: ["msg-1"], sessionId: "pi-session-1" }),
    );
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
});
