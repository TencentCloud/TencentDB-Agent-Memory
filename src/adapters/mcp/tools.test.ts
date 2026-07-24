import { describe, expect, it, vi } from "vitest";

import type { MemoryService } from "../gateway/types.js";
import { registerMemoryTools, type McpToolRegistrar } from "./tools.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function createHarness(service: MemoryService, defaults?: {
  sessionKey?: string;
  userId?: string;
}) {
  const handlers = new Map<string, ToolHandler>();
  const registrar: McpToolRegistrar = {
    registerTool: vi.fn((name, _definition, handler) => {
      handlers.set(name, handler as ToolHandler);
    }),
  };

  registerMemoryTools(registrar, service, defaults);
  return { handlers, registrar };
}

function createService(): MemoryService {
  return {
    health: vi.fn().mockResolvedValue({
      status: "ok",
      version: "0.1.0",
      uptime: 10,
      stores: { vectorStore: true, embeddingService: true },
    }),
    recall: vi.fn().mockResolvedValue({
      context: "The user prefers TypeScript.",
      strategy: "hybrid",
      memoryCount: 1,
    }),
    capture: vi.fn().mockResolvedValue({
      l0Recorded: 2,
      schedulerNotified: true,
    }),
    searchMemories: vi.fn().mockResolvedValue({
      results: "L1 result",
      total: 1,
      strategy: "hybrid",
    }),
    searchConversations: vi.fn().mockResolvedValue({
      results: "L0 result",
      total: 1,
    }),
    endSession: vi.fn().mockResolvedValue({ flushed: true }),
  };
}

describe("registerMemoryTools", () => {
  it("registers the complete cross-platform memory tool surface", () => {
    const service = createService();
    const { handlers } = createHarness(service);

    expect([...handlers.keys()]).toEqual([
      "tdai_health",
      "tdai_recall",
      "tdai_capture",
      "tdai_memory_search",
      "tdai_conversation_search",
      "tdai_session_end",
    ]);
  });

  it("uses configured identity defaults for recall and capture", async () => {
    const service = createService();
    const { handlers } = createHarness(service, {
      sessionKey: "project-session",
      userId: "developer-1",
    });

    const recallResult = await handlers.get("tdai_recall")!({
      query: "What language does the user prefer?",
    });
    const captureResult = await handlers.get("tdai_capture")!({
      user_content: "Use TypeScript",
      assistant_content: "Understood",
    });

    expect(service.recall).toHaveBeenCalledWith({
      query: "What language does the user prefer?",
      sessionKey: "project-session",
      userId: "developer-1",
    });
    expect(service.capture).toHaveBeenCalledWith({
      userContent: "Use TypeScript",
      assistantContent: "Understood",
      sessionKey: "project-session",
      sessionId: undefined,
      userId: "developer-1",
    });
    expect(JSON.parse(recallResult.content[0].text)).toMatchObject({
      context: "The user prefers TypeScript.",
      memory_count: 1,
    });
    expect(JSON.parse(captureResult.content[0].text)).toEqual({
      l0_recorded: 2,
      scheduler_notified: true,
    });
  });

  it("allows per-call session identity and forwards search filters", async () => {
    const service = createService();
    const { handlers } = createHarness(service, { sessionKey: "default-session" });

    await handlers.get("tdai_memory_search")!({
      query: "database preference",
      limit: 8,
      type: "instruction",
      scene: "backend",
    });
    await handlers.get("tdai_conversation_search")!({
      query: "migration",
      limit: 6,
      session_key: "explicit-session",
    });
    await handlers.get("tdai_session_end")!({
      session_key: "explicit-session",
      user_id: "explicit-user",
    });

    expect(service.searchMemories).toHaveBeenCalledWith({
      query: "database preference",
      limit: 8,
      type: "instruction",
      scene: "backend",
    });
    expect(service.searchConversations).toHaveBeenCalledWith({
      query: "migration",
      limit: 6,
      sessionKey: "explicit-session",
    });
    expect(service.endSession).toHaveBeenCalledWith({
      sessionKey: "explicit-session",
      userId: "explicit-user",
    });
  });

  it("returns an actionable tool error when no session key is available", async () => {
    const service = createService();
    const { handlers } = createHarness(service);

    const result = await handlers.get("tdai_capture")!({
      user_content: "Remember this",
      assistant_content: "Stored",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("session_key");
    expect(service.capture).not.toHaveBeenCalled();
  });

  it("converts service failures into MCP error results", async () => {
    const service = createService();
    vi.mocked(service.searchMemories).mockRejectedValue(new Error("Gateway unavailable"));
    const { handlers } = createHarness(service);

    const result = await handlers.get("tdai_memory_search")!({ query: "test" });

    expect(result).toEqual({
      content: [{ type: "text", text: "Gateway unavailable" }],
      isError: true,
    });
  });
});
