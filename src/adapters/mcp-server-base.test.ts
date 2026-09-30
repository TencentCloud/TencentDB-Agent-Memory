import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpServerBase } from "./mcp-server-base.js";
import type { McpServerBaseOptions, McpHostAdapter } from "./mcp-server-base.js";
import { MemoryOperations } from "./memory-operations.js";
import type { TdaiCore } from "../core/tdai-core.js";

// ============================
// Harness
// ============================

function makeCore() {
  return {
    handleBeforeRecall: vi.fn().mockResolvedValue({
      prependContext: "prior facts",
      appendSystemContext: "persona",
      recalledL1Memories: [{ content: "m", score: 1, type: "episodic" }],
      recallStrategy: "hybrid",
    }),
    handleTurnCommitted: vi.fn().mockResolvedValue({
      l0RecordedCount: 2,
      schedulerNotified: true,
      l0VectorsWritten: 2,
      filteredMessages: [],
    }),
    searchMemories: vi.fn().mockResolvedValue({ text: "hit", total: 1, strategy: "vector" }),
    searchConversations: vi.fn().mockResolvedValue({ text: "conv", total: 3 }),
    handleSessionEnd: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

type FakeCore = ReturnType<typeof makeCore>;

const DEFAULT_SESSION = "env-session-key";

class TestMcpServer extends McpServerBase {
  readonly fakeCore: FakeCore;

  constructor(opts: McpServerBaseOptions, fakeCore: FakeCore) {
    super(opts);
    this.fakeCore = fakeCore;
  }

  protected createAdapter(): McpHostAdapter {
    throw new Error("not reached — initCore is overridden");
  }

  protected async initCore(): Promise<void> {
    this.core = this.fakeCore as unknown as TdaiCore;
    this.ops = new MemoryOperations(this.core, this.opts.logger!, "[test]");
    this.adapter = {
      hostType: "cursor",
      getDefaultSessionKey: () => DEFAULT_SESSION,
      getRuntimeContext: () => ({}) as never,
      getLogger: () => this.opts.logger!,
      getLLMRunnerFactory: () => ({}) as never,
    };
    this.initialized = true;
  }

  /** Drive the private tool dispatcher the way handleToolCall does. */
  callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    return this["executeTool"](name, args);
  }
}

// Read the schemas the way an MCP client would — via tools/list.
let TOOLS: ReadonlyArray<{ name: string; inputSchema: { required?: readonly string[] } }> = [];

const silentLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function makeServer(): Promise<TestMcpServer> {
  const s = new TestMcpServer(
    {
      dataDir: "/tmp/tdai-test",
      llmConfig: { baseUrl: "http://x", apiKey: "k", model: "m" } as never,
      logger: silentLogger,
    },
    makeCore(),
  );
  await s["initCore"]();

  // Capture the advertised tool list off the JSON-RPC surface.
  const sent: unknown[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string) => {
    sent.push(JSON.parse(chunk));
    return true;
  };
  try {
    s["handleToolsList"]({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  } finally {
    (process.stdout.write as unknown) = origWrite;
  }
  TOOLS = (sent[0] as { result: { tools: typeof TOOLS } }).result.tools;
  return s;
}

describe("McpServerBase", () => {
  let server: TestMcpServer;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = await makeServer();
  });

  // ============================
  // Advertised surface
  // ============================

  describe("tools/list", () => {
    it("advertises all five memory tools", () => {
      expect(TOOLS.map((t) => t.name)).toEqual([
        "tdai_memory_recall",
        "tdai_memory_capture",
        "tdai_memory_search",
        "tdai_conversation_search",
        "tdai_session_end",
      ]);
    });

    it("reaches parity with the HTTP transport on session end", () => {
      // HTTP has always exposed POST /session/end; MCP platforms previously
      // had no way to flush a session at all.
      expect(TOOLS.some((t) => t.name === "tdai_session_end")).toBe(true);
    });

    it("makes session_key optional on session end so the env default applies", () => {
      const tool = TOOLS.find((t) => t.name === "tdai_session_end")!;
      expect(tool.inputSchema.required ?? []).toEqual([]);
    });
  });

  // ============================
  // Dispatch
  // ============================

  describe("executeTool", () => {
    it("routes recall and renders both context sections", async () => {
      const out = await server.callTool("tdai_memory_recall", { query: "what did I say" });
      expect(server.fakeCore.handleBeforeRecall).toHaveBeenCalledWith(
        "what did I say",
        DEFAULT_SESSION,
      );
      expect(out).toContain("prior facts");
      expect(out).toContain("persona");
    });

    it("routes capture and reports what was persisted", async () => {
      const out = await server.callTool("tdai_memory_capture", {
        user_text: "u",
        assistant_text: "a",
      });
      expect(server.fakeCore.handleTurnCommitted).toHaveBeenCalledTimes(1);
      expect(out).toContain("2 message(s) recorded");
    });

    it("routes both search tools", async () => {
      await server.callTool("tdai_memory_search", { query: "q" });
      await server.callTool("tdai_conversation_search", { query: "q" });
      expect(server.fakeCore.searchMemories).toHaveBeenCalledTimes(1);
      expect(server.fakeCore.searchConversations).toHaveBeenCalledTimes(1);
    });

    it("routes session end using the adapter's default session key", async () => {
      const out = await server.callTool("tdai_session_end");
      expect(server.fakeCore.handleSessionEnd).toHaveBeenCalledWith(DEFAULT_SESSION);
      expect(out).toContain("ended");
    });

    it("prefers an explicit session_key over the adapter default", async () => {
      await server.callTool("tdai_session_end", { session_key: "explicit-key" });
      expect(server.fakeCore.handleSessionEnd).toHaveBeenCalledWith("explicit-key");
    });

    it("rejects an unknown tool", async () => {
      await expect(server.callTool("tdai_not_a_tool")).rejects.toThrow("Unknown tool");
    });
  });

  // ============================
  // Validation reaches the caller
  // ============================

  describe("validation", () => {
    it("surfaces a missing query rather than calling core", async () => {
      await expect(server.callTool("tdai_memory_recall", {})).rejects.toThrow("query");
      expect(server.fakeCore.handleBeforeRecall).not.toHaveBeenCalled();
    });

    it("surfaces a missing assistant_text on capture", async () => {
      await expect(
        server.callTool("tdai_memory_capture", { user_text: "u" }),
      ).rejects.toThrow("assistant_text");
      expect(server.fakeCore.handleTurnCommitted).not.toHaveBeenCalled();
    });
  });

  // ============================
  // Empty-result rendering
  // ============================

  it("reports no memories found instead of an empty string", async () => {
    server.fakeCore.handleBeforeRecall.mockResolvedValue({});
    const out = await server.callTool("tdai_memory_recall", { query: "q" });
    expect(out).toBe("No relevant memories found.");
  });
});
