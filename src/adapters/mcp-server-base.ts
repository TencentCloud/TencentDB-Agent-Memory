/**
 * McpServerBase — shared MCP JSON-RPC stdio server logic for all platforms.
 *
 * Subclasses provide:
 *   createAdapter()      — platform-specific HostAdapter
 *   onAfterInit()        — post-init setup (e.g. start timers)
 *   onBeforeRecall()     — pre-recall hook (e.g. drain a capture queue)
 *   onBeforeShutdown()   — pre-exit flush (e.g. final queue drain)
 *
 * Concrete implementations:
 *   ClaudeCodeMcpServer  — adds Stop-hook queue draining
 *   CursorMcpServer      — no extras; inherits base behaviour directly
 */

import { TdaiCore } from "../core/tdai-core.js";
import { parseConfig } from "../config.js";
import type { HostAdapter, Logger } from "../core/types.js";
import { makeStderrLogger } from "./utils.js";
import type { StandaloneLLMConfig } from "./standalone/llm-runner.js";
import { MemoryOperations } from "./memory-operations.js";
export type { McpHostAdapterOptions } from "./mcp-host-adapter-base.js";

// ============================
// Shared options / adapter interface
// ============================

export interface McpServerBaseOptions {
  dataDir: string;
  llmConfig: StandaloneLLMConfig;
  memoryConfigOverride?: Record<string, unknown>;
  userId?: string;
  defaultSessionKey?: string;
  logger?: Logger;
}

export interface McpHostAdapter extends HostAdapter {
  getDefaultSessionKey(): string;
}

// ============================
// MCP JSON-RPC types (minimal subset)
// ============================

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ============================
// Tool schema definitions
// ============================

const TOOL_SCHEMAS = [
  {
    name: "tdai_memory_recall",
    description:
      "Retrieve relevant memories from TencentDB-Agent-Memory before processing a user message. " +
      "Returns L1 structured memories and L3 persona context that can be injected into the system prompt. " +
      "Call this at the start of each conversation turn to ground the response in past context.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The user's current message or a summary of their intent.",
        },
        session_key: {
          type: "string",
          description:
            "Stable session identifier (use the same value across turns in the same conversation). " +
            "Defaults to the platform session environment variable if omitted.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "tdai_memory_capture",
    description:
      "Record a completed conversation turn to TencentDB-Agent-Memory. " +
      "Call this after the assistant response is finalized to persist the exchange for future recall. " +
      "Background extraction pipelines (L1 episodic, L2 scene, L3 persona) run automatically.",
    inputSchema: {
      type: "object",
      properties: {
        user_text: {
          type: "string",
          description: "The user's message for this turn.",
        },
        assistant_text: {
          type: "string",
          description: "The assistant's response for this turn.",
        },
        session_key: {
          type: "string",
          description: "Session identifier (must match the key used in recall).",
        },
        session_id: {
          type: "string",
          description: "Optional sub-session identifier for grouping turns.",
        },
      },
      required: ["user_text", "assistant_text"],
    },
  },
  {
    name: "tdai_memory_search",
    description:
      "Search L1 structured memories (episodic facts, skills, instructions, user preferences). " +
      "Use this when the user asks about past decisions, preferences, or learned knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (1–20, default 5).",
        },
        type: {
          type: "string",
          enum: ["persona", "episodic", "instruction"],
          description: "Filter by memory type.",
        },
        scene: {
          type: "string",
          description: "Filter by scene / topic label.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "tdai_conversation_search",
    description:
      "Search raw L0 conversation history when structured memories are insufficient. " +
      "Returns individual message excerpts ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return (1–20, default 5).",
        },
        session_key: {
          type: "string",
          description: "Restrict search to a specific conversation session. Omit to search all sessions.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "tdai_session_end",
    description:
      "Signal that the current conversation session is finished. " +
      "Flushes pending L1/L2/L3 extraction pipelines so memories from this session " +
      "become durable immediately instead of waiting for the background scheduler. " +
      "Call this when the user says goodbye or explicitly ends the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        session_key: {
          type: "string",
          description:
            "Session identifier to flush (must match the key used in recall/capture). " +
            "Defaults to the platform session environment variable if omitted.",
        },
      },
      required: [],
    },
  },
] as const;

// ============================
// McpServerBase
// ============================

export abstract class McpServerBase {
  protected readonly opts: McpServerBaseOptions;
  protected readonly logger: Logger;
  protected adapter!: McpHostAdapter;
  protected core!: TdaiCore;
  /** Transport-neutral memory operations — shared with HttpServerBase. */
  protected ops!: MemoryOperations;
  protected initialized = false;

  constructor(opts: McpServerBaseOptions) {
    this.opts = opts;
    this.logger = opts.logger ?? makeStderrLogger();
  }

  /** Create the platform-specific host adapter. */
  protected abstract createAdapter(): McpHostAdapter;

  /** Called after TdaiCore is initialised — start background tasks here. */
  protected async onAfterInit(): Promise<void> {}
  /** Called before each recall — drain queued captures, etc. */
  protected async onBeforeRecall(): Promise<void> {}
  /** Called before process exit — flush any pending state. */
  protected async onBeforeShutdown(): Promise<void> {}

  // ============================
  // Lifecycle
  // ============================

  async start(): Promise<void> {
    await this.initCore();
    await this.onAfterInit();

    process.stdin.setEncoding("utf8");
    let buffer = "";

    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.handleLine(trimmed);
      }
    });

    const shutdown = async () => {
      await this.onBeforeShutdown();
      await this.core.destroy();
      process.exit(0);
    };

    process.stdin.on("end", async () => {
      this.logger.info("[mcp] stdin closed — shutting down");
      await shutdown();
    });

    process.on("SIGTERM", async () => {
      this.logger.info("[mcp] SIGTERM received — shutting down");
      await shutdown();
    });

    process.on("SIGINT", async () => {
      this.logger.info("[mcp] SIGINT received — shutting down");
      await shutdown();
    });

    this.logger.info("[mcp] MCP server started — listening on stdin");
  }

  // ============================
  // Core initialisation
  // ============================

  /**
   * Build the adapter, TdaiCore and the operations facade.
   * Protected so a harness can substitute a prepared core without booting
   * the real storage stack.
   */
  protected async initCore(): Promise<void> {
    const rawConfig: Record<string, unknown> = this.opts.memoryConfigOverride ?? {};
    const memoryConfig = parseConfig(rawConfig);

    this.adapter = this.createAdapter();

    this.core = new TdaiCore({
      hostAdapter: this.adapter,
      config: memoryConfig,
    });

    await this.core.initialize();
    this.ops = new MemoryOperations(this.core, this.logger, "[mcp]");
    this.initialized = true;
    this.logger.info(`[mcp] TdaiCore initialized (dataDir=${this.opts.dataDir})`);
  }

  // ============================
  // JSON-RPC dispatch
  // ============================

  private handleLine(line: string): void {
    let msg: JsonRpcRequest | JsonRpcNotification;
    try {
      msg = JSON.parse(line) as JsonRpcRequest | JsonRpcNotification;
    } catch {
      this.sendError(null, -32700, "Parse error");
      return;
    }

    if (!("id" in msg) || msg.id === undefined) {
      this.handleNotification(msg as JsonRpcNotification);
      return;
    }

    const req = msg as JsonRpcRequest;
    this.dispatchRequest(req).catch((err: unknown) => {
      this.logger.error(`[mcp] Unhandled error in ${req.method}: ${String(err)}`);
      this.sendError(req.id, -32603, "Internal error", String(err));
    });
  }

  private handleNotification(msg: JsonRpcNotification): void {
    if (msg.method === "notifications/initialized") {
      this.logger.info("[mcp] Client initialized");
    }
  }

  private async dispatchRequest(req: JsonRpcRequest): Promise<void> {
    switch (req.method) {
      case "initialize":
        this.handleInitialize(req);
        break;
      case "tools/list":
        this.handleToolsList(req);
        break;
      case "tools/call":
        await this.handleToolCall(req);
        break;
      default:
        this.sendError(req.id, -32601, `Method not found: ${req.method}`);
    }
  }

  // ============================
  // MCP method handlers
  // ============================

  private handleInitialize(req: JsonRpcRequest): void {
    this.sendResult(req.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "tdai-memory",
        version: "1.0.0",
        description: "TencentDB-Agent-Memory",
      },
    });
  }

  private handleToolsList(req: JsonRpcRequest): void {
    this.sendResult(req.id, { tools: TOOL_SCHEMAS });
  }

  private async handleToolCall(req: JsonRpcRequest): Promise<void> {
    if (!this.initialized) {
      this.sendError(req.id, -32002, "Server not ready");
      return;
    }

    const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const toolName = params?.name;
    const args = params?.arguments ?? {};

    if (!toolName) {
      this.sendError(req.id, -32602, "Missing tool name");
      return;
    }

    try {
      const result = await this.executeTool(toolName, args);
      this.sendResult(req.id, {
        content: [{ type: "text", text: result }],
        isError: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[mcp] Tool ${toolName} failed: ${message}`);
      this.sendResult(req.id, {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      });
    }
  }

  // ============================
  // Tool dispatch
  // ============================

  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const sessionKey =
      (args["session_key"] as string | undefined) ?? this.adapter.getDefaultSessionKey();

    switch (name) {
      case "tdai_memory_recall":
        return this.toolRecall(args, sessionKey);
      case "tdai_memory_capture":
        return this.toolCapture(args, sessionKey);
      case "tdai_memory_search":
        return this.toolSearchMemories(args);
      case "tdai_conversation_search":
        return this.toolSearchConversations(args);
      case "tdai_session_end":
        return this.toolSessionEnd(sessionKey);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // ============================
  // Tool implementations
  // ============================

  private async toolRecall(args: Record<string, unknown>, sessionKey: string): Promise<string> {
    await this.onBeforeRecall();

    const result = await this.ops.recall({
      query: String(args["query"] ?? ""),
      sessionKey,
    });

    const parts: string[] = [];
    if (result.prependContext) {
      parts.push(`## Relevant Memories\n${result.prependContext}`);
    }
    if (result.appendSystemContext) {
      parts.push(`## Context\n${result.appendSystemContext}`);
    }
    if (parts.length === 0) return "No relevant memories found.";

    const count = result.recalledL1Memories?.length ?? 0;
    const strategy = result.recallStrategy ?? "unknown";
    parts.push(`\n_(recalled ${count} memor${count === 1 ? "y" : "ies"} via ${strategy})_`);
    return parts.join("\n\n");
  }

  private async toolCapture(args: Record<string, unknown>, sessionKey: string): Promise<string> {
    const result = await this.ops.capture({
      userText: String(args["user_text"] ?? ""),
      assistantText: String(args["assistant_text"] ?? ""),
      sessionKey,
      sessionId: args["session_id"] as string | undefined,
    });

    return (
      `Captured: ${result.l0RecordedCount} message(s) recorded, ` +
      `pipeline scheduled=${result.schedulerNotified}, ` +
      `vectors written=${result.l0VectorsWritten}.`
    );
  }

  private async toolSearchMemories(args: Record<string, unknown>): Promise<string> {
    const result = await this.ops.searchMemories({
      query: String(args["query"] ?? ""),
      limit: typeof args["limit"] === "number" ? args["limit"] : 5,
      type: args["type"] as string | undefined,
      scene: args["scene"] as string | undefined,
    });

    if (result.total === 0) return "No matching memories found.";
    return `${result.text}\n\n_(${result.total} result(s) via ${result.strategy})_`;
  }

  private async toolSearchConversations(args: Record<string, unknown>): Promise<string> {
    const sessionKey = args["session_key"] as string | undefined;

    const result = await this.ops.searchConversations({
      query: String(args["query"] ?? ""),
      limit: typeof args["limit"] === "number" ? args["limit"] : 5,
      sessionKey,
    });

    if (result.total === 0) return "No matching conversation records found.";
    return `${result.text}\n\n_(${result.total} result(s)${sessionKey ? ` in session ${sessionKey}` : ""})_`;
  }

  private async toolSessionEnd(sessionKey: string): Promise<string> {
    await this.ops.sessionEnd(sessionKey);
    return (
      `Session ${sessionKey} ended. Pending L1/L2/L3 extraction pipelines were ` +
      `flushed — memories from this conversation are now durable.`
    );
  }

  // ============================
  // JSON-RPC helpers
  // ============================

  private send(msg: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  private sendResult(id: string | number | null, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  private sendError(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message, data } });
  }
}
