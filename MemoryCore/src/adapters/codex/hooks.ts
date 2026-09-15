/**
 * CodexHooks — Lifecycle hook manager for the Codex CLI adapter.
 *
 * Codex exposes a hook-based integration model where the host CLI calls
 * registered callbacks at specific lifecycle points. This class wraps a
 * {@link CodexAdapter} instance and translates Codex hook invocations
 * into TDAI memory operations:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Codex Lifecycle                                              │
 *   │                                                               │
 *   │  User input ──► beforePromptBuild ──► LLM call ──► afterResp │
 *   │                      │                            │           │
 *   │                      ▼                            ▼           │
 *   │                 recall() ──► context        capture()        │
 *   │                 injected into prompt         persisted to L0  │
 *   │                                                               │
 *   │  Tool call ──► onToolCall ──► handleToolCall() ──► result    │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   ```typescript
 *   import { createCodexAdapter, CodexHooks } from "./codex/index.js";
 *
 *   const adapter = await createCodexAdapter();
 *   const hooks = new CodexHooks(adapter);
 *
 *   // Register with Codex CLI
 *   codex.registerHook("beforePromptBuild", hooks.beforePromptBuild);
 *   codex.registerHook("afterResponse", hooks.afterResponse);
 *   codex.registerHook("onToolCall", hooks.onToolCall);
 *   ```
 */

import { createCodexAdapter } from "./codex-adapter.js";
import type { CodexAdapter, CodexAdapterConfig, CodexMessage } from "./codex-adapter.js";
import type { CaptureResult } from "../sdk/types.js";

// ============================
// Hook result types
// ============================

/**
 * Result of the `beforePromptBuild` hook.
 *
 * - `prependContext`: Markdown text injected before the user's latest
 *   message. Contains L1 relevant memories (dynamic, per-turn).
 * - `appendSystemContext`: Markdown text appended to the system prompt.
 *   Contains L3 persona and L2 scene navigation (stable, cacheable).
 *
 * Both fields are empty strings when no memories are recalled or when
 * the Gateway is unreachable — Codex should always continue normally.
 */
export interface BeforePromptBuildResult {
  prependContext: string;
  appendSystemContext: string;
}

/**
 * Result of the `afterResponse` hook.
 *
 * Mirrors {@link CaptureResult} from the SDK, indicating how many
 * messages were persisted and whether the operation succeeded.
 */
export interface AfterResponseResult {
  capturedCount: number;
  success: boolean;
  error?: string;
}

/**
 * Result of the `onToolCall` hook.
 *
 * The raw tool output string, ready to be returned to Codex as the
 * tool-call result. On error, a JSON envelope with an `error` field
 * is returned instead.
 */
export interface OnToolCallResult {
  result: string;
  success: boolean;
}

// ============================
// Hook handler function signatures
// ============================

/**
 * Signature for the `beforePromptBuild` hook handler.
 *
 * Called before Codex builds the final prompt for the LLM. The hook
 * recalls relevant memories and returns context to inject.
 */
export type BeforePromptBuildHandler = (
  userText: string,
  sessionId: string,
) => Promise<BeforePromptBuildResult>;

/**
 * Signature for the `afterResponse` hook handler.
 *
 * Called after the LLM has produced a response. The hook captures
 * the conversation messages to long-term memory (L0).
 */
export type AfterResponseHandler = (
  messages: CodexMessage[],
  sessionId: string,
) => Promise<AfterResponseResult>;

/**
 * Signature for the `onToolCall` hook handler.
 *
 * Called when the LLM invokes a registered memory tool. The hook
 * dispatches the tool call and returns the formatted result.
 */
export type OnToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<OnToolCallResult>;

// ============================
// CodexHooks
// ============================

/**
 * Lifecycle hook manager that bridges Codex CLI hooks to a
 * {@link CodexAdapter} instance.
 *
 * This class pre-binds three hook handlers (`beforePromptBuild`,
 * `afterResponse`, `onToolCall`) to the adapter so they can be
 * registered directly with Codex's hook system. Every handler is
 * wrapped in error handling that guarantees the hook never throws —
 * a failure degrades gracefully to a no-op rather than disrupting
 * the Codex session.
 */
export class CodexHooks {
  private adapter: CodexAdapter;
  private logger: ((level: string, message: string) => void) | null;

  /**
   * Create a CodexHooks instance wrapping an initialized adapter.
   *
   * @param adapter - An initialized {@link CodexAdapter} (call
   *   `createCodexAdapter()` or `adapter.initialize()` first).
   * @param logger - Optional logging callback for diagnostics.
   *   Receives a log level (`"debug"`, `"info"`, `"warn"`, `"error"`)
   *   and a message string.
   */
  constructor(
    adapter: CodexAdapter,
    logger?: (level: string, message: string) => void,
  ) {
    this.adapter = adapter;
    this.logger = logger ?? null;
  }

  // ============================
  // Bound hook handlers
  // ============================

  /**
   * `beforePromptBuild` hook handler.
   *
   * Recalls relevant memories for the user's latest input and returns
   * Markdown context blocks to inject into the prompt.
   *
   * - `prependContext` is inserted before the user's message.
   * - `appendSystemContext` is appended to the system prompt.
   *
   * This handler never throws. On failure, it returns empty strings
   * so Codex proceeds without memory context.
   */
  readonly beforePromptBuild: BeforePromptBuildHandler = async (
    userText: string,
    sessionId: string,
  ): Promise<BeforePromptBuildResult> => {
    const empty: BeforePromptBuildResult = {
      prependContext: "",
      appendSystemContext: "",
    };

    if (!userText || userText.trim().length === 0) {
      return empty;
    }

    try {
      this.adapter.setSessionId(sessionId);
      const { prependContext, appendSystemContext } = await this.adapter.recall(
        userText,
        sessionId,
      );

      if (prependContext || appendSystemContext) {
        this.log(
          "debug",
          `[codex-hooks] beforePromptBuild: recalled context ` +
            `(prepend=${prependContext.length} chars, ` +
            `append=${appendSystemContext.length} chars) for session=${sessionId}`,
        );
      }

      return {
        prependContext: prependContext ?? "",
        appendSystemContext: appendSystemContext ?? "",
      };
    } catch (err) {
      this.log(
        "warn",
        `[codex-hooks] beforePromptBuild failed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
  };

  /**
   * `afterResponse` hook handler.
   *
   * Captures the conversation messages to long-term memory (L0).
   * Called after the LLM has produced its response for the current turn.
   *
   * This handler never throws. On failure, it returns a failure result
   * with `capturedCount: 0` so Codex continues normally.
   */
  readonly afterResponse: AfterResponseHandler = async (
    messages: CodexMessage[],
    sessionId: string,
  ): Promise<AfterResponseResult> => {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return { capturedCount: 0, success: true };
    }

    try {
      this.adapter.setSessionId(sessionId);
      const result = await this.adapter.capture(messages, sessionId);

      if (result.success) {
        this.log(
          "debug",
          `[codex-hooks] afterResponse: captured ${result.capturedCount} ` +
            `message(s) for session=${sessionId}`,
        );
      } else {
        this.log(
          "warn",
          `[codex-hooks] afterResponse: capture failed for session=${sessionId}` +
            (result.error ? ` — ${result.error}` : ""),
        );
      }

      return {
        capturedCount: result.capturedCount,
        success: result.success,
        error: result.error,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log("warn", `[codex-hooks] afterResponse failed: ${errorMsg}`);
      return { capturedCount: 0, success: false, error: errorMsg };
    }
  };

  /**
   * `onToolCall` hook handler.
   *
   * Dispatches a memory tool invocation (e.g. `tdai_memory_search`,
   * `tdai_conversation_search`, `tdai_read_scene`) and returns the
   * formatted result.
   *
   * This handler never throws. On failure, it returns a JSON error
   * envelope so Codex can surface the error to the LLM.
   */
  readonly onToolCall: OnToolCallHandler = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<OnToolCallResult> => {
    if (!toolName) {
      return {
        result: JSON.stringify({ error: "Tool name is required." }),
        success: false,
      };
    }

    try {
      const result = await this.adapter.handleToolCall(
        toolName,
        args ?? {},
      );

      this.log(
        "debug",
        `[codex-hooks] onToolCall: ${toolName} completed ` +
          `(${result.length} chars output)`,
      );

      return { result, success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log("warn", `[codex-hooks] onToolCall failed for ${toolName}: ${errorMsg}`);
      return {
        result: JSON.stringify({
          error: `Tool '${toolName}' failed: ${errorMsg}`,
        }),
        success: false,
      };
    }
  };

  // ============================
  // Registration helpers
  // ============================

  /**
   * Register all three hook handlers with a Codex hook registry.
   *
   * The `registry` object must provide a `registerHook(name, handler)`
   * method (the standard Codex CLI hook API).
   *
   * @example
   *   ```typescript
   *   const hooks = new CodexHooks(adapter);
   *   hooks.registerAll(codex);
   *   ```
   */
  registerAll(
    registry: {
      registerHook: (
        name: string,
        handler: (...args: never[]) => unknown,
      ) => void;
    },
  ): void {
    registry.registerHook(
      "beforePromptBuild",
      this.beforePromptBuild as unknown as (...args: never[]) => unknown,
    );
    registry.registerHook(
      "afterResponse",
      this.afterResponse as unknown as (...args: never[]) => unknown,
    );
    registry.registerHook(
      "onToolCall",
      this.onToolCall as unknown as (...args: never[]) => unknown,
    );
  }

  /**
   * Register the tool definitions with a Codex tool registry.
   *
   * The `registry` object must provide a `registerTool(definition)`
   * method. This is typically called alongside `registerAll()` during
   * adapter setup.
   *
   * @example
   *   ```typescript
   *   const hooks = new CodexHooks(adapter);
   *   hooks.registerAll(codex);
   *   hooks.registerTools(codex);
   *   ```
   */
  registerTools(
    registry: {
      registerTool: (definition: unknown) => void;
    },
  ): void {
    const tools = this.adapter.getToolDefinitions();
    for (const tool of tools) {
      // Codex uses OpenAI-style function definitions.
      registry.registerTool({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }
    this.log(
      "debug",
      `[codex-hooks] Registered ${tools.length} tool(s) with Codex`,
    );
  }

  // ============================
  // Accessors
  // ============================

  /** Get the underlying adapter instance. */
  getAdapter(): CodexAdapter {
    return this.adapter;
  }

  /**
   * Gracefully shut down the hooks and underlying adapter.
   *
   * Should be called when the Codex session ends to release any
   * resources held by the adapter.
   */
  async shutdown(): Promise<void> {
    try {
      await this.adapter.shutdown();
      this.log("debug", "[codex-hooks] Adapter shut down successfully");
    } catch (err) {
      this.log(
        "warn",
        `[codex-hooks] Shutdown error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ============================
  // Private helpers
  // ============================

  /**
   * Log a message through the optional logger callback.
   * Silently no-ops if no logger was provided.
   */
  private log(level: string, message: string): void {
    this.logger?.(level, message);
  }
}

// ============================
// Factory function
// ============================

/**
 * Create a {@link CodexHooks} instance from an optional adapter config.
 *
 * This is a convenience that combines {@link createCodexAdapter} and
 * `new CodexHooks(adapter)` into a single call.
 *
 * @param config - Optional configuration overrides (see {@link CodexAdapterConfig}).
 * @param logger - Optional logging callback.
 * @returns A `{ hooks, adapter }` tuple, both ready to use.
 *
 * @example
 *   ```typescript
 *   const { hooks, adapter } = await createCodexHooks();
 *   hooks.registerAll(codex);
 *   hooks.registerTools(codex);
 *   ```
 */
export async function createCodexHooks(
  config?: CodexAdapterConfig,
  logger?: (level: string, message: string) => void,
): Promise<{ hooks: CodexHooks; adapter: CodexAdapter }> {
  const adapter = await createCodexAdapter(config);
  const hooks = new CodexHooks(adapter, logger);
  return { hooks, adapter };
}
