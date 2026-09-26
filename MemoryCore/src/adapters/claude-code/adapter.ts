/**
 * ClaudeCodeAdapter — TDAI memory adapter for Anthropic's Claude Code CLI.
 *
 * Claude Code is an agentic CLI tool that communicates with external tools
 * via the Model Context Protocol (MCP). This adapter bridges Claude Code's
 * MCP-based tool-calling convention with the TDAI memory Gateway.
 *
 * Architecture:
 *
 *   Claude Code  <--stdio JSON-RPC-->  TdaiMcpServer  --(calls)-->  ClaudeCodeAdapter
 *                                                                             |
 *                                                                   MemoryAdapterBase
 *                                                                      (recall / capture / search)
 *                                                                             |
 *                                                                     MemoryGatewayClient
 *                                                                      (HTTP v3 API)
 *
 * This adapter extends {@link MemoryAdapterBase} and implements the four
 * abstract methods required by the SDK:
 *
 *   1. `formatRecallResult(result)` — Produces XML-tagged context blocks
 *      compatible with Claude's prompt format (`<relevant-memories>`,
 *      `<user-persona>`, `<scene-navigation>`).
 *   2. `getToolDefinitions()` — Returns the three TDAI memory tool schemas
 *      (`tdai_memory_search`, `tdai_conversation_search`, `tdai_read_scene`).
 *   3. `formatToolResult(toolName, rawResult)` — Formats search/scene
 *      results as plain text for Claude Code consumption.
 *   4. `normalizeMessages(rawMessages)` — Converts Claude Code's message
 *      format (array of `{ role, content }` where content may be a string
 *      or an array of content blocks) into the standard
 *      `ConversationMessage[]`.
 *
 * All Gateway communication, circuit breaking, and graceful degradation
 * are inherited from the base class.
 *
 * Usage:
 *   ```typescript
 *   import { ClaudeCodeAdapter } from "./adapter.js";
 *
 *   const adapter = new ClaudeCodeAdapter();
 *   await adapter.initialize(adapter.resolveConfig());
 *
 *   // The MCP server calls handleToolCall() for each tools/call request.
 *   const result = await adapter.handleToolCall("tdai_memory_search", {
 *     query: "user preferences",
 *   });
 *   ```
 *
 * To start the standalone MCP server:
 *   ```bash
 *   TDAI_GATEWAY_ENDPOINT=http://127.0.0.1:8420 \
 *   TDAI_GATEWAY_API_KEY=secret \
 *   node dist/adapters/claude-code/adapter.js
 *   ```
 */

import { MemoryAdapterBase } from "../sdk/base-adapter.js";
import type {
  AdapterConfig,
  ConversationMessage,
  RecallResult,
  SearchResult,
  TenancyConfig,
  ToolDefinition,
} from "../sdk/types.js";
import { TdaiMcpServer } from "./mcp-server.js";

// ============================
// Environment-variable keys
// ============================

/** Environment variable for the TDAI Gateway base URL. */
const ENV_GATEWAY_ENDPOINT = "TDAI_GATEWAY_ENDPOINT";
/** Environment variable for the TDAI Gateway bearer API key. */
const ENV_GATEWAY_API_KEY = "TDAI_GATEWAY_API_KEY";
/** Environment variable for the TDAI Gateway service / instance ID. */
const ENV_GATEWAY_SERVICE_ID = "TDAI_GATEWAY_SERVICE_ID";
/** Environment variable for the Gateway request timeout (milliseconds). */
const ENV_GATEWAY_TIMEOUT_MS = "TDAI_GATEWAY_TIMEOUT_MS";
/** Environment variable controlling TLS certificate validation. */
const ENV_GATEWAY_REJECT_UNAUTHORIZED = "TDAI_GATEWAY_REJECT_UNAUTHORIZED";

/** Environment variable for the team (tenant) identifier. */
const ENV_TENANCY_TEAM_ID = "TDAI_TEAM_ID";
/** Environment variable for the agent identifier. */
const ENV_TENANCY_AGENT_ID = "TDAI_AGENT_ID";
/** Environment variable for the user identifier. */
const ENV_TENANCY_USER_ID = "TDAI_USER_ID";
/** Environment variable for the session identifier. */
const ENV_SESSION_ID = "TDAI_SESSION_ID";

/** Environment variable controlling whether capture is enabled. */
const ENV_CAPTURE_ENABLED = "TDAI_CAPTURE_ENABLED";
/** Environment variable for max L1 memories to recall per turn. */
const ENV_RECALL_MAX_RESULTS = "TDAI_RECALL_MAX_RESULTS";

/** Default Gateway endpoint used when no environment variable is set. */
const DEFAULT_GATEWAY_ENDPOINT = "http://127.0.0.1:8420";
/** Default Gateway request timeout in milliseconds. */
const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;

// ============================
// Claude Code message format
// ============================

/**
 * A content block within a Claude Code message.
 *
 * Claude Code (Anthropic API) represents message content as either a plain
 * string or an array of typed content blocks. The relevant block types for
 * memory capture are:
 *
 * - `text` — standard text content
 * - `tool_use` — a tool invocation request from the assistant
 * - `tool_result` — the result returned by a tool
 */
export interface ClaudeContentBlock {
  /** Content block type. */
  type: "text" | "tool_use" | "tool_result" | "image" | string;
  /** Text content (for `text` blocks). */
  text?: string;
  /** Tool call ID (for `tool_use` and `tool_result` blocks). */
  id?: string;
  /** Tool name (for `tool_use` blocks). */
  name?: string;
  /** Tool input arguments (for `tool_use` blocks). */
  input?: unknown;
  /** Tool result content (for `tool_result` blocks). */
  content?: string | Array<{ type: string; text?: string }>;
  /** Whether the tool call resulted in an error. */
  is_error?: boolean;
}

/**
 * A single message in Claude Code's conversation format.
 *
 * Claude Code represents conversation turns as a flat array of objects,
 * each with a `role` and `content`. The `content` field may be a plain
 * string or an array of {@link ClaudeContentBlock} objects.
 */
export interface ClaudeMessage {
  /** Message role. */
  role: "user" | "assistant" | "system" | string;
  /**
   * Message content. May be a plain string or an array of content blocks
   * (e.g. `[{ type: "text", text: "..." }]`).
   */
  content: string | ClaudeContentBlock[];
  /** ISO 8601 timestamp of the message (optional). */
  timestamp?: string;
}

// ============================
// Tool definitions (Claude Code specific)
// ============================

/**
 * Tool definition for `tdai_memory_search`.
 *
 * Searches structured L1 memories for relevant fragments about user
 * preferences, past events, rules, and facts.
 */
const MEMORY_SEARCH_TOOL: ToolDefinition = {
  name: "tdai_memory_search",
  label: "Memory Search",
  description:
    "Search structured memories (L1). Returns relevant memory fragments about " +
    "user preferences, past events, rules, and facts. Use this when you need " +
    "to recall specific information about the user or past interactions.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query text (natural language).",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 5).",
      },
      type: {
        type: "string",
        description: "Filter by memory type (e.g. 'persona', 'episodic', 'instruction').",
      },
    },
    required: ["query"],
  },
};

/**
 * Tool definition for `tdai_conversation_search`.
 *
 * Searches raw L0 conversation history for original messages with
 * timestamps.
 */
const CONVERSATION_SEARCH_TOOL: ToolDefinition = {
  name: "tdai_conversation_search",
  label: "Conversation Search",
  description:
    "Search raw conversation history (L0). Returns original messages with " +
    "timestamps. Use this to find specific past messages, timelines, or " +
    "detailed context from previous conversations.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query text.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 5).",
      },
      session_key: {
        type: "string",
        description: "Filter by session ID.",
      },
    },
    required: ["query"],
  },
};

/**
 * Tool definition for `tdai_read_scene`.
 *
 * Reads the full content of a scene block by its name. Use when a scene
 * is listed in the Scene Navigation section of recalled context.
 */
const READ_SCENE_TOOL: ToolDefinition = {
  name: "tdai_read_scene",
  label: "Read Scene",
  description:
    "Read a scene block's full content by its name. Use when you see a scene " +
    "listed in Scene Navigation and need to read its details.",
  parameters: {
    type: "object",
    properties: {
      scene_id: {
        type: "string",
        description: "Scene file name (e.g. 'travel-plan.md').",
      },
    },
    required: ["scene_id"],
  },
};

// ============================
// XML-tagged context block templates
// ============================

/**
 * Memory tools guide injected into the system prompt.
 *
 * This block guides Claude Code to proactively use the memory tools when
 * injected context is insufficient, while respecting a per-turn call limit.
 */
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## Memory Tools Guide

When the injected memory context above is insufficient to answer the user's
question, you may proactively call the following tools to retrieve more
information:

- **tdai_memory_search**: Search structured memories (L1) for user
  preferences, historical events, rules, and facts.
- **tdai_conversation_search**: Search raw conversation history (L0) for
  specific message text, timelines, and contextual details.
- **tdai_read_scene**: Read a scene file's full content (use paths from the
  Scene Navigation section, e.g. \`scene_blocks/xxx.md\`).

### Call Limit
Per conversation turn, tdai_memory_search and tdai_conversation_search may
be called a combined maximum of 3 times. If the first search returns no
results, you may retry with different keywords or a different tool, but the
total number of calls must not exceed 3. If no results are found after 3
searches, the information is not in memory — respond based on available
context.
</memory-tools-guide>`;

// ============================
// ClaudeCodeAdapter
// ============================

/**
 * TDAI memory adapter for Claude Code.
 *
 * Bridges Claude Code's MCP-based tool-calling convention with the TDAI
 * memory Gateway. Extends {@link MemoryAdapterBase} to inherit all Gateway
 * communication, circuit breaking, and graceful degradation.
 */
export class ClaudeCodeAdapter extends MemoryAdapterBase {
  readonly platformName = "claude-code";

  /**
   * Optional configuration overrides passed at construction time.
   * When undefined, all values are resolved from environment variables.
   */
  private configOverrides?: ClaudeCodeAdapterConfig;

  constructor(configOverrides?: ClaudeCodeAdapterConfig) {
    super();
    this.configOverrides = configOverrides;
  }

  // ============================
  // Abstract method implementations
  // ============================

  /**
   * Format a recall result into XML-tagged context blocks for Claude's
   * prompt format.
   *
   * Produces two outputs:
   * - `prependContext` — Dynamic L1 memories wrapped in
   *   `<relevant-memories>` tags, injected before the user's message.
   * - `appendSystemContext` — Stable content appended to the system prompt:
   *   `<user-persona>` (L3), `<scene-navigation>` (L2), and
   *   `<memory-tools-guide>`.
   *
   * Claude understands XML tags natively, making this an effective way to
   * delimit injected context sections.
   */
  formatRecallResult(result: RecallResult): {
    prependContext?: string;
    appendSystemContext?: string;
  } {
    // --- L1 memories → prependContext ---
    const prependParts: string[] = [];

    if (result.memories.length > 0) {
      const lines: string[] = ["<relevant-memories>", ""];
      for (const item of result.memories) {
        const typeTag = item.type ? `[${item.type}]` : "[memory]";
        const scoreStr =
          typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
        lines.push(`- ${typeTag}${scoreStr} ${item.content}`);
      }
      lines.push("");
      lines.push("</relevant-memories>");
      prependParts.push(lines.join("\n"));
    }

    // --- L3 persona + L2 scenes + tools guide → appendSystemContext ---
    const appendParts: string[] = [];

    // L3 persona
    if (result.persona?.content) {
      appendParts.push("<user-persona>");
      appendParts.push(result.persona.content);
      appendParts.push("</user-persona>");
      appendParts.push("");
    }

    // L2 scene navigation
    if (result.scenes.length > 0) {
      const sceneLines: string[] = [
        "<scene-navigation>",
        "The following scene memory index is available. Use tdai_read_scene to read any scene's full content.",
        "",
      ];
      for (const scene of result.scenes) {
        const summary = scene.summary ? ` — ${scene.summary}` : "";
        sceneLines.push(`- \`${scene.path}\`${summary}`);
      }
      sceneLines.push("");
      sceneLines.push("</scene-navigation>");
      appendParts.push(sceneLines.join("\n"));
      appendParts.push("");
    }

    // Tools guide (always appended)
    appendParts.push(MEMORY_TOOLS_GUIDE);

    return {
      prependContext: prependParts.length > 0 ? prependParts.join("\n\n") : undefined,
      appendSystemContext: appendParts.length > 0 ? appendParts.join("\n\n") : undefined,
    };
  }

  /**
   * Return the three TDAI memory tool definitions for Claude Code.
   *
   * These are registered with Claude Code via the MCP `tools/list` method.
   */
  getToolDefinitions(): ToolDefinition[] {
    return [MEMORY_SEARCH_TOOL, CONVERSATION_SEARCH_TOOL, READ_SCENE_TOOL];
  }

  /**
   * Format a tool call result for Claude Code consumption.
   *
   * Returns plain text that Claude Code will display as the tool result.
   * For search results, includes formatted memory/conversation entries.
   * For scene reads, returns the raw content.
   */
  formatToolResult(
    toolName: string,
    rawResult: SearchResult | string,
  ): string {
    // If the result is already a plain string (e.g. scene content or error),
    // return it directly.
    if (typeof rawResult === "string") {
      return rawResult;
    }

    // SearchResult — format based on tool name
    const { text, total, items } = rawResult;

    switch (toolName) {
      case "tdai_memory_search": {
        if (items.length === 0) {
          return text || "No memories found for this query.";
        }
        const lines: string[] = [
          `Found ${items.length} matching memor${items.length === 1 ? "y" : "ies"} (total: ${total}):`,
          "",
        ];
        for (const item of items) {
          const scoreStr =
            typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
          lines.push(`- **[${item.type}]**${scoreStr}`);
          lines.push(`  ${item.content}`);
          lines.push("");
        }
        return lines.join("\n");
      }

      case "tdai_conversation_search": {
        if (items.length === 0) {
          return text || "No conversation messages found for this query.";
        }
        const lines: string[] = [
          `Found ${items.length} matching message${items.length === 1 ? "" : "s"} (total: ${total}):`,
          "",
        ];
        for (const item of items) {
          const scoreStr =
            typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
          const ts = item.metadata?.timestamp
            ? ` [${String(item.metadata.timestamp)}]`
            : "";
          lines.push("---");
          lines.push(`**[${item.type}]**${ts}${scoreStr}`);
          lines.push("");
          lines.push(item.content);
          lines.push("");
        }
        return lines.join("\n");
      }

      case "tdai_read_scene": {
        // Scene content is returned as the raw text
        return text;
      }

      default:
        return text;
    }
  }

  /**
   * Normalize Claude Code's message format into the standard
   * `ConversationMessage[]`.
   *
   * Claude Code messages are arrays of `{ role, content }` where `content`
   * may be:
   * - A plain string
   * - An array of content blocks (`{ type: "text", text: "..." }`,
   *   `{ type: "tool_use", ... }`, `{ type: "tool_result", ... }`)
   *
   * This method extracts text from all block types and maps roles to the
   * standard set (`user`, `assistant`, `system`, `tool`).
   */
  normalizeMessages(
    rawMessages: unknown,
    context?: Record<string, unknown>,
  ): ConversationMessage[] {
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    const results: ConversationMessage[] = [];
    const defaultTimestamp =
      typeof context?.timestamp === "string" ? context.timestamp : undefined;

    for (const raw of rawMessages) {
      if (!raw || typeof raw !== "object") continue;

      const msg = raw as ClaudeMessage;
      const role = this.normalizeRole(msg.role);
      const content = this.extractTextContent(msg.content);
      const timestamp = msg.timestamp ?? defaultTimestamp;

      if (content.trim()) {
        results.push({ role, content: content.trim(), timestamp });
      }
    }

    return results;
  }

  // ============================
  // Configuration resolution
  // ============================

  /**
   * Resolve adapter configuration from constructor overrides and
   * environment variables.
   *
   * Environment variables take effect when no constructor override is
   * provided for the corresponding field. This allows flexible deployment:
   * the adapter can be configured entirely via env vars (for the MCP
   * server entry point) or programmatically (for embedded use).
   *
   * @returns A complete {@link AdapterConfig} ready for `initialize()`.
   */
  resolveConfig(): AdapterConfig {
    const overrides = this.configOverrides;

    const endpoint =
      overrides?.gateway?.endpoint ??
      process.env[ENV_GATEWAY_ENDPOINT] ??
      DEFAULT_GATEWAY_ENDPOINT;

    const apiKey =
      overrides?.gateway?.apiKey ??
      process.env[ENV_GATEWAY_API_KEY] ??
      undefined;

    const serviceId =
      overrides?.gateway?.serviceId ??
      process.env[ENV_GATEWAY_SERVICE_ID] ??
      "default";

    const timeoutMs =
      overrides?.gateway?.timeoutMs ??
      (process.env[ENV_GATEWAY_TIMEOUT_MS]
        ? parseInt(process.env[ENV_GATEWAY_TIMEOUT_MS]!, 10)
        : DEFAULT_GATEWAY_TIMEOUT_MS);

    const rejectUnauthorized =
      overrides?.gateway?.rejectUnauthorized ??
      (process.env[ENV_GATEWAY_REJECT_UNAUTHORIZED]
        ? process.env[ENV_GATEWAY_REJECT_UNAUTHORIZED] !== "false"
        : true);

    const tenancy: TenancyConfig = {
      teamId: overrides?.tenancy?.teamId ?? process.env[ENV_TENANCY_TEAM_ID] ?? "default",
      agentId: overrides?.tenancy?.agentId ?? process.env[ENV_TENANCY_AGENT_ID] ?? "default",
      userId: overrides?.tenancy?.userId ?? process.env[ENV_TENANCY_USER_ID] ?? "default",
    };

    const recallMaxResults =
      overrides?.recallMaxResults ??
      (process.env[ENV_RECALL_MAX_RESULTS]
        ? parseInt(process.env[ENV_RECALL_MAX_RESULTS]!, 10)
        : undefined);

    const captureEnabled =
      overrides?.captureEnabled ??
      (process.env[ENV_CAPTURE_ENABLED]
        ? process.env[ENV_CAPTURE_ENABLED] !== "false"
        : undefined);

    return {
      gateway: {
        endpoint,
        apiKey,
        serviceId,
        timeoutMs,
        rejectUnauthorized,
      },
      tenancy,
      recallMaxResults,
      recallIncludePersona: overrides?.recallIncludePersona ?? true,
      recallIncludeSceneNav: overrides?.recallIncludeSceneNav ?? true,
      captureEnabled,
    };
  }

  // ============================
  // Overridable hook implementations
  // ============================

  /** Called when the Gateway becomes reachable after initialize(). */
  protected onGatewayReady(): void {
    process.stderr.write("[tdai:claude-code] Gateway connected and ready\n");
  }

  /** Called when the Gateway is not reachable at initialize(). */
  protected onGatewayUnavailable(status: string): void {
    process.stderr.write(
      `[tdai:claude-code] Gateway unavailable (status: ${status}). ` +
        "Memory tools will return empty results until the Gateway recovers.\n",
    );
  }

  /** Called when a recall operation fails. */
  protected onRecallError(err: Error): void {
    process.stderr.write(`[tdai:claude-code] Recall error: ${err.message}\n`);
  }

  /** Called when a capture operation fails. */
  protected onCaptureError(errorMsg: string): void {
    process.stderr.write(`[tdai:claude-code] Capture error: ${errorMsg}\n`);
  }

  // ============================
  // Private helpers
  // ============================

  /**
   * Normalize a role string to the standard set.
   *
   * Claude Code uses `user`, `assistant`, and `system`. Tool-related
   * messages may use other role names; we map them to the closest
   * standard role.
   */
  private normalizeRole(role: string): ConversationMessage["role"] {
    switch (role) {
      case "user":
        return "user";
      case "assistant":
        return "assistant";
      case "system":
        return "system";
      case "tool":
      case "function":
        return "tool";
      default:
        // Unknown roles default to "user" to preserve the message
        return "user";
    }
  }

  /**
   * Extract text content from a Claude Code message's content field.
   *
   * Handles both plain-string content and arrays of content blocks.
   * For `tool_use` blocks, includes the tool name and serialized input.
   * For `tool_result` blocks, includes the result text.
   */
  private extractTextContent(
    content: string | ClaudeContentBlock[],
  ): string {
    if (typeof content === "string") {
      return content;
    }

    if (!Array.isArray(content)) {
      return String(content ?? "");
    }

    const parts: string[] = [];

    for (const block of content) {
      if (!block || typeof block !== "object") continue;

      switch (block.type) {
        case "text": {
          if (block.text) {
            parts.push(block.text);
          }
          break;
        }
        case "tool_use": {
          const inputStr = block.input
            ? JSON.stringify(block.input)
            : "(no input)";
          parts.push(`[tool_use: ${block.name ?? "unknown"}(${inputStr})]`);
          break;
        }
        case "tool_result": {
          if (typeof block.content === "string") {
            parts.push(`[tool_result: ${block.content}]`);
          } else if (Array.isArray(block.content)) {
            const textParts = block.content
              .map((c) => c?.text ?? "")
              .filter((t) => t.length > 0);
            if (textParts.length > 0) {
              parts.push(`[tool_result: ${textParts.join(" ")}]`);
            }
          }
          break;
        }
        default: {
          // For unknown block types, try to extract text
          if (block.text) {
            parts.push(block.text);
          }
          break;
        }
      }
    }

    return parts.join("\n");
  }
}

// ============================
// Configuration type
// ============================

/**
 * Optional configuration passed to {@link ClaudeCodeAdapter}.
 *
 * Every field is optional — when omitted, the adapter reads from
 * environment variables at `resolveConfig()` time.
 */
export interface ClaudeCodeAdapterConfig {
  /** Gateway connection overrides. */
  gateway?: {
    endpoint?: string;
    apiKey?: string;
    serviceId?: string;
    timeoutMs?: number;
    rejectUnauthorized?: boolean;
  };
  /** Tenancy overrides. */
  tenancy?: TenancyConfig;
  /** Max L1 memories to recall per turn. */
  recallMaxResults?: number;
  /** Whether to include L3 persona in recall. */
  recallIncludePersona?: boolean;
  /** Whether to include L2 scene navigation in recall. */
  recallIncludeSceneNav?: boolean;
  /** Whether conversation capture is enabled. */
  captureEnabled?: boolean;
}

// ============================
// Entry point: main()
// ============================

/**
 * Start the Claude Code MCP server.
 *
 * This is the main entry point when the adapter is run as a standalone
 * MCP server process. It:
 *
 * 1. Resolves configuration from environment variables.
 * 2. Creates and initializes the {@link ClaudeCodeAdapter}.
 * 3. Starts the {@link TdaiMcpServer} listening on stdio.
 *
 * The server runs until stdin is closed or the process receives SIGINT /
 * SIGTERM, at which point it shuts down gracefully.
 *
 * Environment variables:
 * - `TDAI_GATEWAY_ENDPOINT` — Gateway base URL (default: `http://127.0.0.1:8420`)
 * - `TDAI_GATEWAY_API_KEY` — Bearer API key for authentication
 * - `TDAI_GATEWAY_SERVICE_ID` — Service / instance ID
 * - `TDAI_GATEWAY_TIMEOUT_MS` — Request timeout in milliseconds
 * - `TDAI_GATEWAY_REJECT_UNAUTHORIZED` — Set to `false` to disable TLS cert validation
 * - `TDAI_TEAM_ID` — Team (tenant) identifier
 * - `TDAI_AGENT_ID` — Agent identifier
 * - `TDAI_USER_ID` — User identifier
 * - `TDAI_SESSION_ID` — Default session identifier
 * - `TDAI_CAPTURE_ENABLED` — Set to `false` to disable conversation capture
 * - `TDAI_RECALL_MAX_RESULTS` — Max L1 memories to recall per turn
 */
export async function main(): Promise<void> {
  const adapter = new ClaudeCodeAdapter();
  const config = adapter.resolveConfig();

  // Set session ID from environment if provided
  const sessionId = process.env[ENV_SESSION_ID];
  if (sessionId) {
    adapter.setSessionId(sessionId);
  }

  process.stderr.write(
    `[tdai:claude-code] Starting MCP server (gateway: ${config.gateway.endpoint})\n`,
  );

  // Initialize the adapter (connects to Gateway, health check)
  await adapter.initialize(config);

  // Create and start the MCP server
  const server = new TdaiMcpServer(adapter);

  // Handle graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[tdai:claude-code] Received ${signal}, shutting down...\n`);
    try {
      server.stop();
      await adapter.shutdown();
    } catch (err) {
      process.stderr.write(
        `[tdai:claude-code] Error during shutdown: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Start the JSON-RPC server on stdio
  server.start();
}

// Start the server when this module is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(
      `[tdai:claude-code] Fatal error: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(1);
  });
}
