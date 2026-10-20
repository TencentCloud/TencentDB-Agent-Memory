import type {
  ProcessInputArgs,
  ProcessOutputResultArgs,
  Processor,
} from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import type { SessionEndResponse } from "../../gateway/types.js";
import type {
  GatewayMemoryClient,
  GatewayPlatformContext,
} from "../gateway-client/index.js";

const PROCESSOR_ID = "tencentdb-agent-memory";
const MEMORY_BLOCK_OPEN = '<relevant-memories source="tencentdb-agent-memory">';
const MEMORY_BLOCK_CLOSE = "</relevant-memories>";

// Public Mastra RequestContext keys. RequestContext values take precedence over
// client-provided memory metadata, matching Mastra's own memory processors.
const MASTRA_THREAD_ID_KEY = "mastra__threadId";
const MASTRA_RESOURCE_ID_KEY = "mastra__resourceId";

type MastraProcessorArgs = Pick<
  ProcessInputArgs | ProcessOutputResultArgs,
  "messageList" | "requestContext"
>;

export interface MastraMemoryAdapterError {
  phase: "recall" | "capture" | "flush";
  error: unknown;
}

export interface MastraMemoryProcessorOptions {
  /** Shared Gateway client from the #316 adapter baseline. */
  client: GatewayMemoryClient;
  /** Optional fail-open diagnostics. Errors thrown here are ignored. */
  onError?: (event: MastraMemoryAdapterError) => void;
}

export interface FlushMastraSessionOptions {
  /** Shared Gateway client from the #316 adapter baseline. */
  client: GatewayMemoryClient;
  /** Stable Mastra thread identifier. */
  threadId: string;
  /** Mastra resource identifier, normally the authenticated user. */
  resourceId?: string;
  /** Optional fail-open diagnostics. Errors thrown here are ignored. */
  onError?: (event: MastraMemoryAdapterError) => void;
}

/**
 * Create a Mastra Processor that recalls before model input and captures the
 * completed user/assistant turn after generation.
 */
export function createMastraMemoryProcessor(
  options: MastraMemoryProcessorOptions,
): Processor {
  return {
    id: PROCESSOR_ID,
    name: "TencentDB Agent Memory",
    description: "Gateway-backed recall and capture for Mastra agents",

    async processInput(args) {
      const query = args.messageList.getLatestUserContent()?.trim();
      const context = resolveMastraContext(args);
      if (!query || !context) return args.messageList;

      args.messageList.clearSystemMessages(PROCESSOR_ID);

      try {
        const recalled = await options.client.recall({
          query,
          session_key: context.sessionKey,
          user_id: context.userId,
        });
        const recalledContext = recalled.context.trim();
        if (!recalledContext) return args.messageList;

        args.messageList.addSystem(
          `${MEMORY_BLOCK_OPEN}\n${recalledContext}\n${MEMORY_BLOCK_CLOSE}`,
          PROCESSOR_ID,
        );
      } catch (error) {
        reportError(options.onError, { phase: "recall", error });
      }

      return args.messageList;
    },

    async processOutputResult(args) {
      const query = args.messageList.getLatestUserContent()?.trim();
      const context = resolveMastraContext(args);
      const assistantText = args.result.text.trim();
      if (
        !query
        || !context
        || !assistantText
        || !isTerminalFinishReason(args.result.finishReason)
      ) {
        return args.messageList;
      }

      try {
        await options.client.capture({
          user_content: query,
          assistant_content: assistantText,
          session_key: context.sessionKey,
          session_id: context.sessionId,
          user_id: context.userId,
        });
      } catch (error) {
        reportError(options.onError, { phase: "capture", error });
      }

      return args.messageList;
    },
  };
}

/**
 * Flush a Mastra conversation when the host application knows the thread has
 * actually ended. Mastra Processors do not expose a multi-turn session-end hook.
 */
export async function flushMastraSession(
  options: FlushMastraSessionOptions,
): Promise<SessionEndResponse | undefined> {
  const threadId = options.threadId.trim();
  if (!threadId) return undefined;

  try {
    return await options.client.endSession({
      session_key: createSessionKey(threadId),
      user_id: nonEmptyString(options.resourceId),
    });
  } catch (error) {
    reportError(options.onError, { phase: "flush", error });
    return undefined;
  }
}

function resolveMastraContext(args: MastraProcessorArgs): GatewayPlatformContext | undefined {
  const serialized = args.messageList.serialize();
  const threadId = readRequestContext(args.requestContext, MASTRA_THREAD_ID_KEY)
    ?? nonEmptyString(serialized.memoryInfo?.threadId);
  if (!threadId) return undefined;

  const resourceId = readRequestContext(args.requestContext, MASTRA_RESOURCE_ID_KEY)
    ?? nonEmptyString(serialized.memoryInfo?.resourceId);
  return {
    sessionKey: createSessionKey(threadId),
    sessionId: threadId,
    userId: resourceId,
  };
}

function readRequestContext(
  requestContext: RequestContext | undefined,
  key: string,
): string | undefined {
  if (!requestContext) return undefined;
  try {
    return nonEmptyString(requestContext.get(key));
  } catch {
    return undefined;
  }
}

function createSessionKey(threadId: string): string {
  return `mastra:${threadId}`;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isTerminalFinishReason(reason: string): boolean {
  return reason === "stop" || reason === "length";
}

function reportError(
  onError: MastraMemoryProcessorOptions["onError"] | FlushMastraSessionOptions["onError"],
  event: MastraMemoryAdapterError,
): void {
  try {
    onError?.(event);
  } catch {
    // Diagnostics must not break the agent or session shutdown path.
  }
}
