/**
 * CodexAdapter — TDAI memory adapter for OpenAI Codex CLI.
 *
 * Codex is an OpenAI-based CLI agent that supports hooks and tool
 * registration. Unlike OpenClaw (which uses an in-process plugin API),
 * Codex exposes a lifecycle-hook model:
 *
 *   - `beforePromptBuild(userText, sessionId)` — recall memories and return
 *     context to inject into the prompt.
 *   - `afterResponse(messages, sessionId)` — capture the conversation turn
 *     to long-term memory.
 *   - `onToolCall(toolName, args)` — dispatch a memory tool invocation.
 *
 * This adapter extends {@link MemoryAdapterBase} and implements the four
 * abstract methods required by the SDK. All Gateway communication, circuit
 * breaking, and graceful degradation are inherited from the base class.
 *
 * Usage:
 *   ```typescript
 *   import { createCodexAdapter } from "./codex/index.js";
 *
 *   const adapter = createCodexAdapter();
 *   await adapter.initialize(adapter.resolveConfig());
 *
 *   const { prependContext, appendSystemContext } =
 *     await adapter.recall("What did we discuss about React?", "session-1");
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

/** Environment variable controlling whether capture is enabled. */
const ENV_CAPTURE_ENABLED = "TDAI_CAPTURE_ENABLED";
/** Environment variable for max L1 memories to recall per turn. */
const ENV_RECALL_MAX_RESULTS = "TDAI_RECALL_MAX_RESULTS";

/** Default Gateway endpoint used when no environment variable is set. */
const DEFAULT_GATEWAY_ENDPOINT = "http://127.0.0.1:8420";
/** Default Gateway request timeout in milliseconds. */
const DEFAULT_GATEWAY_TIMEOUT_MS = 10_000;

// ============================
// Codex message format
// ============================

/**
 * A single message in Codex's conversation format.
 *
 * Codex represents conversation turns as a flat array of objects, each
 * with a `role`, `content`, and an optional `timestamp`. The `content`
 * field may be a plain string or an array of content blocks (matching
 * the OpenAI Chat Completions multi-modal schema).
 */
export interface CodexMessage {
  /** Message role — `user`, `assistant`, `system`, or `tool`. */
  role: "user" | "assistant" | "system" | "tool" | string;
  /**
   * Message content. May be a plain string or an array of content
   * blocks (e.g. `[{ type: "text", text: "..." }]`).
   */
  content: string | Array<{ type: string; text?: string } | string> | unknown;
  /** ISO 8601 timestamp of the message (optional). */
  timestamp?: string;
  /** Optional tool-call identifier (for `tool` role messages). */
  tool_call_id?: string;
  /** Optional tool-call name. */
  name?: string;
}

// ============================
// Configuration types
// ============================

/**
 * Optional configuration passed to {@link createCodexAdapter}.
 *
 * Every field is optional — when omitted, the adapter reads from
 * environment variables at `resolveConfig()` time.
 */
export interface CodexAdapterConfig {
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
// Codex-specific tool definitions
// ============================

/**
 * Memory search tool definition tailored for Codex's tool-registration
 * convention. Codex uses OpenAI-style function-calling schemas.
 */
export const CODEX_MEMORY_SEARCH_TOOL: ToolDefinition = {
  name: "tdai_memory_search",
  label: "Memory Search",
  description:
    "Search structured long-term memories (L1). Returns relevant memory " +
    "fragments about user preferences, past events, rules, and facts. " +
    "Use when you need to recall something discussed previously.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 5).",
      },
      type: {
        type: "string",
        description: "Filter results by memory type (e.g. 'episodic', 'persona').",
      },
    },
    required: ["query"],
  },
};

/**
 * Conversation search tool definition for Codex.
 */
export const CODEX_CONVERSATION_SEARCH_TOOL: ToolDefinition = {
  name: "tdai_conversation_search",
  label: "Conversation Search",
  description:
    "Search raw conversation history (L0). Returns original messages with " +
    "timestamps. Use when you need to find a specific past exchange.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results (default: 5).",
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
 * Scene read tool definition for Codex.
 */
export const CODEX_READ_SCENE_TOOL: ToolDefinition = {
  name: "tdai_read_scene",
  label: "Read Scene",
  description:
    "Read a scene block's full content by its name. Use when you see a " +
    "scene listed in the Scene Navigation context and need the full details.",
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
// CodexAdapter
// ============================

/**
 * TDAI memory adapter for OpenAI Codex CLI.
 *
 * Extends {@link MemoryAdapterBase} and implements the four abstract
 * methods required by the SDK. The adapter formats recall results as
 * Markdown context blocks and normalizes Codex's message format into
 * the standard {@link ConversationMessage} shape.
 */
export class CodexAdapter extends MemoryAdapterBase {
  readonly platformName = "codex";

  // ============================
  // Abstract method implementations
  // ============================

  /**
   * Format a recall result into Markdown context blocks for Codex.
   *
   * Codex prompts are Markdown-based, so recall context is rendered as
   * fenced sections with clear headers. The output is split into:
   *
   * - `prependContext`: L1 relevant memories — injected before the user's
   *   latest message (dynamic, changes every turn).
   * - `appendSystemContext`: L3 persona + L2 scene navigation — appended
   *   to the system prompt (stable, cacheable across turns).
   */
  formatRecallResult(result: RecallResult): {
    prependContext?: string;
    appendSystemContext?: string;
  } {
    const parts: { prependContext?: string; appendSystemContext?: string } = {};

    // ── L1 memories → prependContext (dynamic, per-turn) ──
    if (result.memories.length > 0) {
      const lines = result.memories.map((m) => {
        const scoreSuffix =
          typeof m.score === "number" ? ` (score: ${m.score.toFixed(2)})` : "";
        return `- **[${m.type}]** ${m.content}${scoreSuffix}`;
      });

      parts.prependContext =
        `## Relevant Memories\n\n` +
        `The following memories were recalled for this conversation. ` +
        `They are contextual references only and may not reflect the current task.\n\n` +
        `${lines.join("\n")}\n`;
    }

    // ── L3 persona + L2 scenes → appendSystemContext (stable) ──
    const systemParts: string[] = [];

    if (result.persona?.content) {
      systemParts.push(
        `## User Persona\n\n${result.persona.content.trim()}`,
      );
    }

    if (result.scenes.length > 0) {
      const sceneLines = result.scenes.map((s) => {
        const heat =
          typeof s.heat === "number" ? ` _(heat: ${s.heat})_` : "";
        const summary = s.summary ? ` — ${s.summary}` : "";
        return `- \`${s.path}\`${summary}${heat}`;
      });
      systemParts.push(
        `## Scene Navigation\n\n` +
        `The following scene blocks are available. Use the ` +
        `\`tdai_read_scene\` tool to read a scene's full content.\n\n` +
        `${sceneLines.join("\n")}`,
      );
    }

    if (systemParts.length > 0) {
      systemParts.push(
        `## Memory Tools\n\n` +
        `- \`tdai_memory_search\` — Search structured memories (L1).\n` +
        `- \`tdai_conversation_search\` — Search raw conversations (L0).\n` +
        `- \`tdai_read_scene\` — Read a scene block by name.\n\n` +
        `_Limit: max 3 combined search calls per turn._`,
      );
      parts.appendSystemContext = systemParts.join("\n\n");
    }

    return parts;
  }

  /**
   * Return the tool definitions this adapter exposes to Codex's LLM.
   *
   * Uses Codex-specific tool names and descriptions that match the
   * OpenAI function-calling schema convention.
   */
  getToolDefinitions(): ToolDefinition[] {
    return [
      CODEX_MEMORY_SEARCH_TOOL,
      CODEX_CONVERSATION_SEARCH_TOOL,
      CODEX_READ_SCENE_TOOL,
    ];
  }

  /**
   * Format a tool call result for Codex's expected response format.
   *
   * Codex expects tool results as plain text or JSON strings. Memory
   * search results are rendered as Markdown bullet lists; scene reads
   * are passed through as-is; errors are wrapped in a JSON envelope.
   */
  formatToolResult(
    toolName: string,
    rawResult: SearchResult | string,
  ): string {
    // Plain string results (e.g. scene reads) — pass through directly.
    if (typeof rawResult === "string") {
      return rawResult;
    }

    // SearchResult — format as Markdown.
    if (rawResult.total === 0 || rawResult.items.length === 0) {
      return `_No results found for \`${toolName}\`._`;
    }

    const lines = rawResult.items.map((item) => {
      const scoreSuffix =
        typeof item.score === "number" ? ` _(score: ${item.score.toFixed(2)})_` : "";
      const tsSuffix =
        item.metadata && typeof item.metadata.timestamp === "string"
          ? ` \`${item.metadata.timestamp}\``
          : "";
      return `- **[${item.type}]** ${item.content}${scoreSuffix}${tsSuffix}`;
    });

    return `### ${toolName} Results (${rawResult.total} found)\n\n${lines.join("\n")}\n`;
  }

  /**
   * Normalize Codex's message format into the standard
   * {@link ConversationMessage} shape.
   *
   * Codex represents conversations as an array of `{ role, content,
   * timestamp }` objects. The `content` field may be:
   * - A plain string (most common).
   * - An array of content blocks (OpenAI multi-modal schema), e.g.
   *   `[{ type: "text", text: "..." }]`.
   * - `null` or `undefined` (e.g. for pure tool-call assistant messages).
   *
   * This method handles all three cases gracefully and skips messages
   * with no extractable text content.
   */
  normalizeMessages(
    rawMessages: unknown,
    _context?: Record<string, unknown>,
  ): ConversationMessage[] {
    if (!Array.isArray(rawMessages)) {
      return [];
    }

    const messages: ConversationMessage[] = [];

    for (const raw of rawMessages) {
      if (!raw || typeof raw !== "object") {
        continue;
      }

      const msg = raw as CodexMessage;
      const role = this.normalizeRole(msg.role);
      if (!role) {
        continue;
      }

      const content = this.extractTextContent(msg.content);
      if (!content || content.trim().length === 0) {
        // Skip messages with no text content (e.g. pure tool-call messages).
        continue;
      }

      messages.push({
        role,
        content,
        timestamp: msg.timestamp,
      });
    }

    return messages;
  }

  // ============================
  // Overridable hook implementations
  // ============================

  /**
   * Called when the Gateway becomes reachable after initialize().
   * Logs a debug message for Codex's observability.
   */
  protected override onGatewayReady(): void {
    // Intentionally quiet — Codex hooks log at the hooks layer.
  }

  /**
   * Called when the Gateway is not reachable at initialize().
   * The adapter will still function but recall/capture will be no-ops
   * until the circuit breaker resets.
   */
  protected override onGatewayUnavailable(_status: string): void {
    // Intentionally quiet — graceful degradation is handled by the base class.
  }

  /**
   * Called when a recall operation fails. Non-fatal — the adapter
   * returns empty context so Codex continues without memory.
   */
  protected override onRecallError(_err: Error): void {
    // Errors are swallowed to avoid disrupting the Codex session.
  }

  /**
   * Called when a capture operation fails. Non-fatal — the conversation
   * turn is simply not persisted to long-term memory.
   */
  protected override onCaptureError(_errorMsg: string): void {
    // Errors are swallowed to avoid disrupting the Codex session.
  }

  // ============================
  // Configuration resolution
  // ============================

  /**
   * Build an {@link AdapterConfig} from environment variables, merged
   * with any overrides provided in the constructor config.
   *
   * This is typically called by {@link createCodexAdapter} before
   * `initialize()`, but can also be called manually for advanced
   * setups.
   *
   * Environment variables read:
   * - `TDAI_GATEWAY_ENDPOINT` (default: `http://127.0.0.1:8420`)
   * - `TDAI_GATEWAY_API_KEY`
   * - `TDAI_GATEWAY_SERVICE_ID`
   * - `TDAI_GATEWAY_TIMEOUT_MS` (default: 10000)
   * - `TDAI_GATEWAY_REJECT_UNAUTHORIZED` (default: true)
   * - `TDAI_TEAM_ID` (default: "default")
   * - `TDAI_AGENT_ID` (default: "default")
   * - `TDAI_USER_ID` (default: "default")
   * - `TDAI_CAPTURE_ENABLED` (default: true)
   * - `TDAI_RECALL_MAX_RESULTS` (default: 5)
   */
  resolveConfig(): AdapterConfig {
    return resolveCodexConfig(this.constructorConfig);
  }

  /**
   * Store the constructor config for later resolution in `resolveConfig()`.
   * Set by the factory function.
   * @internal
   */
  private constructorConfig: CodexAdapterConfig | undefined;

  /**
   * Set the constructor-level config overrides.
   * @internal
   */
  _setConstructorConfig(config: CodexAdapterConfig | undefined): void {
    this.constructorConfig = config;
  }

  // ============================
  // Private helpers
  // ============================

  /**
   * Normalize a Codex message role into the standard set.
   * Unknown roles are mapped to the closest standard role or rejected.
   */
  private normalizeRole(
    role: string | undefined,
  ): ConversationMessage["role"] | null {
    if (!role || typeof role !== "string") {
      return null;
    }
    const lower = role.toLowerCase();
    switch (lower) {
      case "user":
      case "human":
        return "user";
      case "assistant":
      case "ai":
      case "bot":
        return "assistant";
      case "system":
      case "developer":
        return "system";
      case "tool":
      case "function":
        return "tool";
      default:
        // Unknown role — skip to avoid corrupting the conversation.
        return null;
    }
  }

  /**
   * Extract text content from a Codex message's `content` field.
   *
   * Handles three shapes:
   * 1. Plain string — returned directly.
   * 2. Array of content blocks — concatenates all `text`-type blocks.
   * 3. `null` / `undefined` / other — returns empty string.
   */
  private extractTextContent(
    content: CodexMessage["content"],
  ): string {
    if (content == null) {
      return "";
    }

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (typeof block === "string") {
          texts.push(block);
        } else if (block && typeof block === "object") {
          const typedBlock = block as { type?: string; text?: string };
          if (
            (typedBlock.type === "text" || typedBlock.type === "input_text" || !typedBlock.type) &&
            typeof typedBlock.text === "string"
          ) {
            texts.push(typedBlock.text);
          }
        }
      }
      return texts.join("\n");
    }

    return "";
  }
}

// ============================
// Configuration resolution (module-level)
// ============================

/**
 * Resolve a full {@link AdapterConfig} from environment variables,
 * merged with optional overrides.
 *
 * Exported for testing and advanced manual setup.
 */
export function resolveCodexConfig(
  overrides?: CodexAdapterConfig,
): AdapterConfig {
  const env = process.env;

  const endpoint =
    overrides?.gateway?.endpoint ??
    env[ENV_GATEWAY_ENDPOINT] ??
    DEFAULT_GATEWAY_ENDPOINT;

  const apiKey =
    overrides?.gateway?.apiKey ??
    env[ENV_GATEWAY_API_KEY] ??
    undefined;

  const serviceId =
    overrides?.gateway?.serviceId ??
    env[ENV_GATEWAY_SERVICE_ID] ??
    undefined;

  const timeoutMs =
    overrides?.gateway?.timeoutMs ??
    parsePositiveInt(env[ENV_GATEWAY_TIMEOUT_MS], DEFAULT_GATEWAY_TIMEOUT_MS);

  const rejectUnauthorized =
    overrides?.gateway?.rejectUnauthorized ??
    parseBoolean(env[ENV_GATEWAY_REJECT_UNAUTHORIZED], true);

  const tenancy: TenancyConfig = {
    teamId: overrides?.tenancy?.teamId ?? env[ENV_TENANCY_TEAM_ID] ?? "default",
    agentId: overrides?.tenancy?.agentId ?? env[ENV_TENANCY_AGENT_ID] ?? "default",
    userId: overrides?.tenancy?.userId ?? env[ENV_TENANCY_USER_ID] ?? "default",
  };

  const captureEnabled =
    overrides?.captureEnabled ??
    parseBoolean(env[ENV_CAPTURE_ENABLED], true);

  const recallMaxResults =
    overrides?.recallMaxResults ??
    parsePositiveInt(env[ENV_RECALL_MAX_RESULTS], 5);

  return {
    gateway: {
      endpoint,
      apiKey,
      serviceId,
      timeoutMs,
      rejectUnauthorized,
    },
    tenancy,
    captureEnabled,
    recallMaxResults,
    recallIncludePersona: overrides?.recallIncludePersona ?? true,
    recallIncludeSceneNav: overrides?.recallIncludeSceneNav ?? true,
  };
}

// ============================
// Factory function
// ============================

/**
 * Create and initialize a Codex adapter.
 *
 * If no config is provided, the adapter reads all settings from
 * environment variables (see {@link resolveCodexConfig}).
 *
 * The adapter is initialized and a best-effort health check is
 * performed. If the Gateway is unreachable, the adapter still
 * returns successfully — recall and capture will gracefully
 * degrade to no-ops until the circuit breaker resets.
 *
 * @param config - Optional configuration overrides.
 * @returns An initialized {@link CodexAdapter} instance.
 *
 * @example
 *   ```typescript
 *   // From environment variables
 *   const adapter = createCodexAdapter();
 *
 *   // With explicit overrides
 *   const adapter = createCodexAdapter({
 *     gateway: { endpoint: "http://localhost:8420" },
 *     tenancy: { userId: "alice" },
 *   });
 *   ```
 */
export async function createCodexAdapter(
  config?: CodexAdapterConfig,
): Promise<CodexAdapter> {
  const adapter = new CodexAdapter();
  adapter._setConstructorConfig(config);
  const resolved = resolveCodexConfig(config);
  await adapter.initialize(resolved);
  return adapter;
}

// ============================
// Internal parsing helpers
// ============================

/**
 * Parse a positive integer from a string, returning a default on failure.
 */
function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Parse a boolean from a string, returning a default on failure.
 *
 * Accepts: "true", "1", "yes", "on" (case-insensitive) as truthy.
 * Accepts: "false", "0", "no", "off" (case-insensitive) as falsy.
 */
function parseBoolean(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (!raw) return fallback;
  const lower = raw.trim().toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
    return false;
  }
  return fallback;
}
