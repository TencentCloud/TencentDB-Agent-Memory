import { CodingAgentGatewayClient } from "./gateway-client.js";
import type {
  CodingAgentGatewayClientOptions,
  CodingAgentRecallRequest,
  CodingAgentTurn,
} from "./gateway-client.js";

/**
 * Unified coding-agent adapter SDK.
 *
 * A new coding-agent platform (Claude Code, Codex, Cursor, Continue, ...) is
 * integrated by implementing a single {@link CodingAgentPlatformAdapter}
 * interface. Everything else — HTTP transport, timeouts, Bearer auth, recall
 * context flattening, and fail-open error handling — is provided once by
 * {@link runCodingAgentAdapter}, so platform bindings stay thin.
 */

/** Gateway recall payload shape, tolerant of the legacy `context` field. */
export interface CodingAgentRecallLike {
  context?: string;
  prepend_context?: string;
  append_system_context?: string;
}

/**
 * Minimal Gateway client contract the SDK depends on.
 * {@link CodingAgentGatewayClient} satisfies it structurally.
 */
export interface CodingAgentClient {
  health(): Promise<unknown>;
  recall(request: CodingAgentRecallRequest): Promise<CodingAgentRecallLike>;
  capture(turn: CodingAgentTurn): Promise<unknown>;
  endSession(sessionKey: string, userId?: string): Promise<unknown>;
}

/** Host-neutral memory lifecycle event produced by a platform binding. */
export type CodingAgentEvent =
  | { kind: "recall"; recall: CodingAgentRecallRequest }
  | { kind: "capture"; turn: CodingAgentTurn }
  | { kind: "session-end"; sessionKey: string; userId?: string }
  | { kind: "health" }
  | { kind: "noop" };

/**
 * The one interface a platform must implement.
 *
 * - `toEvent` maps a platform-native payload into a neutral lifecycle event.
 * - `renderRecall` maps recalled memory back into the platform's native
 *   response shape (only called when there is non-empty context to inject).
 */
export interface CodingAgentPlatformAdapter<TInput> {
  /** Stable platform id, surfaced in diagnostics (e.g. "claude-code"). */
  readonly platform: string;
  toEvent(input: TInput): CodingAgentEvent | Promise<CodingAgentEvent>;
  renderRecall(context: string, input: TInput): unknown;
}

export interface CodingAgentAdapterOptions {
  client?: CodingAgentClient;
  gateway?: CodingAgentGatewayClientOptions;
}

export interface CodingAgentAdapterResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Drive one platform adapter through the memory lifecycle against the Gateway.
 *
 * Always fails open: any Gateway or parsing error is reported on stderr with
 * exit code 0, so the host agent is never blocked when memory is unavailable.
 */
export async function runCodingAgentAdapter<TInput>(
  adapter: CodingAgentPlatformAdapter<TInput>,
  input: TInput,
  options: CodingAgentAdapterOptions = {},
): Promise<CodingAgentAdapterResult> {
  const client = options.client ?? new CodingAgentGatewayClient(options.gateway);

  try {
    const event = await adapter.toEvent(input);
    switch (event.kind) {
      case "recall": {
        const response = await client.recall(event.recall);
        const context = combineRecallContext(response);
        if (!context) return { exitCode: 0 };
        return { exitCode: 0, stdout: JSON.stringify(adapter.renderRecall(context, input)) };
      }
      case "capture":
        await client.capture(event.turn);
        return { exitCode: 0 };
      case "session-end":
        if (event.userId !== undefined) await client.endSession(event.sessionKey, event.userId);
        else await client.endSession(event.sessionKey);
        return { exitCode: 0 };
      case "health":
        await client.health();
        return { exitCode: 0 };
      default:
        return { exitCode: 0 };
    }
  } catch (err) {
    return {
      exitCode: 0,
      stderr: `tdai ${adapter.platform} adapter skipped: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Flatten a Gateway recall response into a single injectable string.
 *
 * Combines dynamic L1 (`prepend_context`) with stable persona/scene context
 * (`append_system_context`, falling back to the legacy `context` field),
 * de-duplicates, and strips the tool-guide block that is only relevant to MCP
 * tool hosts rather than context-injection hooks.
 */
export function combineRecallContext(response: CodingAgentRecallLike): string {
  const dynamicContext = response.prepend_context?.trim();
  const stableContext = (response.append_system_context ?? response.context)
    ?.replace(/<memory-tools-guide>[\s\S]*?<\/memory-tools-guide>/gi, "")
    .trim();
  return [...new Set([dynamicContext, stableContext].filter((value): value is string => !!value))]
    .join("\n\n");
}
