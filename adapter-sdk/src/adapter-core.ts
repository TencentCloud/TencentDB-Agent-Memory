/**
 * MemoryAdapter — the generic orchestrator that turns a {@link PlatformBinding}
 * into a fully working memory integration.
 *
 * A binding only knows how to translate its platform's payloads
 * (parse/format). This class owns everything else:
 *   - calling the Gateway via {@link GatewayClient}
 *   - skipping events the binding declines (parse* → null)
 *   - swallowing errors so memory failures never break the host agent
 *   - exposing the two memory tools with platform-appropriate names
 *
 * A new platform therefore needs to implement exactly one interface
 * (`PlatformBinding`) and call these `handle*` methods from its event hooks.
 */

import { GatewayClient } from "./gateway-client.js";
import type {
  PlatformBinding,
  AdapterLogger,
  ToolDescriptor,
  ToolName,
  MemorySearchInput,
  ConversationSearchInput,
  SearchOutput,
  RecallOutput,
  CaptureOutput,
} from "./types.js";

export interface MemoryAdapterOptions {
  binding: PlatformBinding;
  client: GatewayClient;
  logger?: AdapterLogger;
}

// Default tool schemas (parameters), shared across platforms.
const MEMORY_SEARCH_PARAMS: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query describing what to recall about the user.",
    },
    limit: {
      type: "integer",
      description: "Maximum number of results (default: 5, max: 20).",
    },
    type: {
      type: "string",
      enum: ["persona", "episodic", "instruction"],
      description: "Optional filter by memory type.",
    },
  },
  required: ["query"],
};

const CONVERSATION_SEARCH_PARAMS: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query describing the conversation content to find.",
    },
    limit: {
      type: "integer",
      description: "Maximum number of messages (default: 5, max: 20).",
    },
  },
  required: ["query"],
};

export class MemoryAdapter {
  private readonly binding: PlatformBinding;
  private readonly client: GatewayClient;
  private readonly logger?: AdapterLogger;

  constructor(opts: MemoryAdapterOptions) {
    this.binding = opts.binding;
    this.client = opts.client;
    this.logger = opts.logger;
  }

  get platform(): string {
    return this.binding.platform;
  }

  private toolName(name: ToolName): string {
    return this.binding.toolNames?.[name] ?? name;
  }

  // ============================
  // Lifecycle handlers
  // ============================

  /**
   * Handle a recall trigger. Returns the platform-native output produced by
   * the binding's `formatRecall`, or `null` when the event was skipped or the
   * Gateway failed (memory must never break the host turn).
   */
  async handleRecall(raw: unknown): Promise<unknown> {
    const input = this.binding.parseRecall(raw);
    if (!input || !input.query) {
      this.logger?.debug?.(`[${this.platform}] recall skipped (no input)`);
      return null;
    }
    try {
      const result: RecallOutput = await this.client.recall(input);
      this.logger?.debug?.(
        `[${this.platform}] recall ok: ${result.memoryCount} memories, ${result.context.length} chars`,
      );
      return this.binding.formatRecall(result, raw);
    } catch (err) {
      this.logger?.warn(`[${this.platform}] recall failed: ${errMsg(err)}`);
      return null;
    }
  }

  /**
   * Handle a turn-end capture. Returns the binding's formatted output (if it
   * provides `formatCapture`), otherwise the raw {@link CaptureOutput}, or
   * `null` on skip/failure.
   */
  async handleCapture(raw: unknown): Promise<unknown> {
    const input = this.binding.parseCapture(raw);
    if (!input || (!input.userContent && !input.assistantContent)) {
      this.logger?.debug?.(`[${this.platform}] capture skipped (no input)`);
      return null;
    }
    try {
      const result: CaptureOutput = await this.client.capture(input);
      this.logger?.debug?.(
        `[${this.platform}] capture ok: l0=${result.l0Recorded}, scheduled=${result.schedulerNotified}`,
      );
      return this.binding.formatCapture?.(result, raw) ?? result;
    } catch (err) {
      this.logger?.warn(`[${this.platform}] capture failed: ${errMsg(err)}`);
      return null;
    }
  }

  /** Handle a session-end flush. Best-effort; never throws. */
  async handleSessionEnd(raw: unknown): Promise<void> {
    const input = this.binding.parseSessionEnd(raw);
    if (!input || !input.sessionKey) {
      this.logger?.debug?.(`[${this.platform}] session-end skipped (no input)`);
      return;
    }
    try {
      await this.client.endSession(input);
      this.logger?.debug?.(`[${this.platform}] session-end flushed: ${input.sessionKey}`);
    } catch (err) {
      this.logger?.warn(`[${this.platform}] session-end failed: ${errMsg(err)}`);
    }
  }

  // ============================
  // Tools
  // ============================

  /** Tool descriptors with platform-appropriate names. */
  listTools(): ToolDescriptor[] {
    return [
      {
        name: this.toolName("memory_search"),
        description:
          "Search the user's long-term memories (preferences, past events, " +
          "instructions). Returns records ranked by relevance.",
        parameters: MEMORY_SEARCH_PARAMS,
      },
      {
        name: this.toolName("conversation_search"),
        description:
          "Search past raw conversation history. Use when memory_search lacks " +
          "the detail you need or you want exact past wording.",
        parameters: CONVERSATION_SEARCH_PARAMS,
      },
    ];
  }

  /**
   * Execute a tool call by (platform) name. Returns a JSON-serializable object
   * suitable for returning to the host LLM.
   */
  async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<SearchOutput | { error: string }> {
    try {
      if (name === this.toolName("memory_search")) {
        const query = String(args.query ?? "");
        if (!query) return { error: "Missing required parameter: query" };
        const input: MemorySearchInput = {
          query,
          limit: coerceLimit(args.limit),
          type: typeof args.type === "string" ? args.type : undefined,
          scene: typeof args.scene === "string" ? args.scene : undefined,
        };
        return await this.client.searchMemories(input);
      }
      if (name === this.toolName("conversation_search")) {
        const query = String(args.query ?? "");
        if (!query) return { error: "Missing required parameter: query" };
        const input: ConversationSearchInput = {
          query,
          limit: coerceLimit(args.limit),
          sessionKey: typeof args.session_key === "string" ? args.session_key : undefined,
        };
        return await this.client.searchConversations(input);
      }
      return { error: `Unknown tool: ${name}` };
    } catch (err) {
      this.logger?.warn(`[${this.platform}] tool ${name} failed: ${errMsg(err)}`);
      return { error: `Tool call failed: ${errMsg(err)}` };
    }
  }
}

// ============================
// helpers
// ============================

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Coerce a possibly-stringy tool `limit` into an int in [1, 20]. */
function coerceLimit(raw: unknown, def = 5, max = 20): number {
  if (raw == null || raw === "") return def;
  if (typeof raw === "boolean") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < 1) return 1;
  if (i > max) return max;
  return i;
}
