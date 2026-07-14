/**
 * CodexAdapter — Gateway-based adapter for Codex / VS Code extension integration.
 *
 * ─── Architecture ──────────────────────────────────────────────────────────
 *
 * Codex integrates with the memory system through:
 *
 *   1. **ChatParticipant callbacks** — resolve() for recall, afterTurn for capture
 *   2. **vscode.lm.registerTool()** — for tdai_memory_search / tdai_conversation_search
 *   3. **Extension Context** — for data directory resolution
 *
 * Unlike Claude Code (subprocess hooks), Codex runs as a long-lived process
 * in the VS Code Extension Host. The adapter holds a persistent
 * GatewayMemoryClient and resolves session identity from workspace context.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  Codex (VS Code Extension Host)                              │
 *   │  ┌─────────────────┐  ┌────────────────┐  ┌───────────────┐ │
 *   │  │ ChatParticipant │  │ ToolProvider   │  │ MCP Server    │ │
 *   │  │ resolve/recall  │  │ search tools   │  │ (optional)    │ │
 *   │  └────────┬────────┘  └───────┬────────┘  └──────┬────────┘ │
 *   └───────────┼──────────────────┼──────────────────┼────────────┘
 *               │                  │                  │
 *               ▼                  ▼                  ▼
 *           GatewayMemoryClient  GatewayMemoryClient  GatewayMemoryClient
 *               │                  │                   │
 *               └──────────────────┼───────────────────┘
 *                                  ▼
 *                           TDAI Gateway (daemon)
 *                           TdaiCore / SQLite / Pipeline
 *
 * ─── Usage ─────────────────────────────────────────────────────────────────
 *
 * ```ts
 * import { CodexAdapter } from "./index.js";
 *
 * const adapter = new CodexAdapter({
 *   gatewayUrl: "http://127.0.0.1:8420",
 * });
 *
 * // Before LLM turn:
 * const recall = await adapter.recall("user message", "session-key");
 *
 * // After LLM turn:
 * await adapter.capture({
 *   userText: "user message",
 *   assistantText: "assistant response",
 *   messages: [...],
 *   sessionKey: "session-key",
 * });
 * ```
 *
 * ─── VS Code Integration ───────────────────────────────────────────────────
 *
 * In your extension's activate() function:
 *
 * ```ts
 * import { CodexAdapter } from "memory-tdai/src/adapters/codex/index.js";
 *
 * export function activate(context: vscode.ExtensionContext) {
 *   const adapter = new CodexAdapter({
 *     gatewayUrl: vscode.workspace.getConfiguration("memory-tdai").get("gatewayUrl"),
 *     apiKey: vscode.workspace.getConfiguration("memory-tdai").get("apiKey"),
 *     workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
 *   });
 *
 *   // Register tools
 *   const memoryTool = vscode.lm.registerTool("tdai_memory_search", {
 *     async invoke(options, token) {
 *       const query = options.input.query;
 *       const result = await adapter.searchMemories({ query });
 *       return new vscode.LanguageModelToolResult([
 *         new vscode.LanguageModelTextPart(result.text)
 *       ]);
 *     },
 *   });
 *   context.subscriptions.push(memoryTool);
 * }
 * ```
 *
 * @see GatewayMemoryClient — the underlying HTTP client
 */

import { GatewayMemoryClient } from "../gateway-client/index.js";
import type { Logger } from "../../core/types.js";

// ============================
// Defaults & env var keys
// ============================

const GATEWAY_URL_ENV = "TDAI_GATEWAY_URL";
const GATEWAY_API_KEY_ENV = "TDAI_GATEWAY_API_KEY";

// ============================
// CodexAdapter
// ============================

export interface CodexAdapterOptions {
  /**
   * TDAI Gateway URL. Falls back to TDAI_GATEWAY_URL env var,
   * then http://127.0.0.1:8420.
   */
  gatewayUrl?: string;
  /** Gateway API key. Falls back to TDAI_GATEWAY_API_KEY env var. */
  apiKey?: string;
  /**
   * Workspace root path for deriving stable session keys.
   * Falls back to process.cwd().
   */
  workspaceRoot?: string;
  /** Logger override. Falls back to default console logger. */
  logger?: Logger;
  /** Custom fetch implementation for testing. */
  fetchImpl?: typeof fetch;
  /** Request timeout in milliseconds (default: 10000). */
  timeoutMs?: number;
}

export class CodexAdapter {
  readonly platform = "codex";
  readonly logger: Logger;

  /** The underlying Gateway HTTP client. */
  readonly client: GatewayMemoryClient;

  /** Workspace root for session key derivation. */
  readonly workspaceRoot: string;

  constructor(opts?: CodexAdapterOptions) {
    this.logger = opts?.logger ?? createCodexLogger();
    this.workspaceRoot = opts?.workspaceRoot ?? process.cwd();
    this.client = new GatewayMemoryClient({
      baseUrl: opts?.gatewayUrl ?? process.env[GATEWAY_URL_ENV] ?? "http://127.0.0.1:8420",
      apiKey: opts?.apiKey ?? process.env[GATEWAY_API_KEY_ENV],
      fetchImpl: opts?.fetchImpl,
      timeoutMs: opts?.timeoutMs,
    });
  }

  // ============================
  // Session identity
  // ============================

  /**
   * Derive a stable session key from a workspace-relative session root.
   *
   * The default strategy uses `workspaceRoot` as a namespace so that
   * memory is scoped per-workspace:
   *
   *   `codex:${path.basename(workspaceRoot)}:${sessionId}`
   *
   * @param sessionId — Optional run-specific identifier (e.g. conversation id).
   * @returns A scoped session key string.
   */
  resolveSessionKey(sessionId?: string): string {
    const projectName = basename(this.workspaceRoot);
    if (sessionId) {
      return `codex:${projectName}:${sessionId}`;
    }
    return `codex:${projectName}:default`;
  }

  // ============================
  // Core operations
  // ============================

  /**
   * Perform memory recall for a user message.
   * Delegates to POST /recall on the Gateway.
   */
  async recall(
    userText: string,
    sessionKey: string,
  ): Promise<{ prependContext?: string; strategy?: string }> {
    if (!userText || !sessionKey) return {};

    try {
      const result = await this.client.recall({ query: userText, session_key: sessionKey });
      return {
        prependContext: result.context,
        strategy: result.strategy,
      };
    } catch (err) {
      this.logger.error(`[codex] Recall failed: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }

  /**
   * Capture a completed conversation turn.
   * Delegates to POST /capture on the Gateway.
   */
  async capture(turn: {
    userText: string;
    assistantText: string;
    messages: unknown[];
    sessionKey: string;
    sessionId?: string;
    success?: boolean;
  }): Promise<void> {
    if (!turn.sessionKey || turn.success === false) return;

    try {
      const result = await this.client.capture({
        user_content: turn.userText,
        assistant_content: turn.assistantText,
        messages: turn.messages,
        session_key: turn.sessionKey,
        session_id: turn.sessionId,
      });
      this.logger.info?.(
        `[codex] Capture complete: l0Recorded=${result.l0_recorded}, ` +
        `schedulerNotified=${result.scheduler_notified}`,
      );
    } catch (err) {
      this.logger.error(`[codex] Capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Search L1 structured memories.
   * Delegates to POST /search/memories on the Gateway.
   */
  async searchMemories(params: {
    query: string;
    limit?: number;
    type?: string;
    scene?: string;
  }): Promise<{ text: string; total: number }> {
    try {
      const result = await this.client.searchMemories({
        query: params.query,
        limit: params.limit,
        type: params.type,
        scene: params.scene,
      });
      return { text: result.results, total: result.total };
    } catch (err) {
      this.logger.error(`[codex] searchMemories failed: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", total: 0 };
    }
  }

  /**
   * Search L0 raw conversations.
   * Delegates to POST /search/conversations on the Gateway.
   */
  async searchConversations(params: {
    query: string;
    limit?: number;
    sessionKey?: string;
  }): Promise<{ text: string; total: number }> {
    try {
      const result = await this.client.searchConversations({
        query: params.query,
        limit: params.limit,
        session_key: params.sessionKey,
      });
      return { text: result.results, total: result.total };
    } catch (err) {
      this.logger.error(`[codex] searchConversations failed: ${err instanceof Error ? err.message : String(err)}`);
      return { text: "", total: 0 };
    }
  }

  /**
   * End a session and flush buffered state.
   * Delegates to POST /session/end on the Gateway.
   */
  async sessionEnd(sessionKey: string): Promise<void> {
    if (!sessionKey) return;

    try {
      await this.client.endSession({ session_key: sessionKey });
      this.logger.info?.(`[codex] Session ended: ${sessionKey}`);
    } catch (err) {
      this.logger.error(`[codex] sessionEnd failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ============================
// Utilities
// ============================

function basename(p: string): string {
  const normalized = p.replace(/[/\\]+$/, ""); // strip trailing separators
  const sep = normalized.replace(/\\/g, "/").lastIndexOf("/");
  return sep >= 0 ? normalized.slice(sep + 1) : normalized;
}

function createCodexLogger(): Logger {
  const isDebug = process.env.DEBUG?.includes("memory-tdai") ?? false;
  return {
    debug: isDebug ? (msg: string) => console.error(`[memory-tdai/codex] ${msg}`) : undefined,
    info: (msg: string) => console.error(`[memory-tdai/codex] ${msg}`),
    warn: (msg: string) => console.error(`[memory-tdai/codex] ${msg}`),
    error: (msg: string) => console.error(`[memory-tdai/codex] ${msg}`),
  };
}
