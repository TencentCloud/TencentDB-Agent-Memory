import { createMemoryTools, type MemoryTools } from "../mcp/tools.js";
import { OpenCodeSessionState, opencodeSessionKey } from "./session.js";

interface OpenCodeTextPart {
  type: "text";
  text: string;
  ignored?: boolean;
  synthetic?: boolean;
}

interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  parentID?: string;
  time?: { created?: number; completed?: number };
  error?: unknown;
  finish?: string;
}

interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: Array<OpenCodeTextPart | Record<string, unknown>>;
}

interface OpenCodeClient {
  session: {
    messages(input: {
      path: { id: string };
      query: { directory: string };
      throwOnError: true;
    }): Promise<{ data?: OpenCodeMessage[] | null }>;
  };
}

export interface OpenCodePluginInput {
  client: OpenCodeClient;
  directory: string;
  project?: unknown;
  worktree?: string;
  $?: unknown;
}

interface OpenCodeChatMessageInput {
  sessionID: string;
  messageID?: string;
}

interface OpenCodeChatMessageOutput {
  message: OpenCodeMessageInfo;
  parts: Array<OpenCodeTextPart | Record<string, unknown>>;
}

interface OpenCodeSystemTransformInput {
  sessionID?: string;
  model: unknown;
}

interface OpenCodeSystemTransformOutput {
  system: string[];
}

interface OpenCodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

/** Default upper bound for dispose waiting on in-flight session queue work. */
export const OPENCODE_PLUGIN_DISPOSE_TIMEOUT_MS = 5_000;

export interface OpenCodeHooks {
  "chat.message"?: (input: OpenCodeChatMessageInput, output: OpenCodeChatMessageOutput) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: OpenCodeSystemTransformInput,
    output: OpenCodeSystemTransformOutput,
  ) => Promise<void>;
  "experimental.chat.messages.transform"?: (
    input: Record<string, never>,
    output: { messages: OpenCodeMessage[] },
  ) => Promise<void>;
  event?: (input: { event: OpenCodeEvent }) => Promise<void>;
  /** OpenCode legacy Plugin API finalizer; waits for session queues with a timeout. */
  dispose?: () => Promise<void>;
}

export interface OpenCodePluginOptions {
  stateDir?: string;
  tools?: MemoryTools;
  log?: (message: string) => void;
  /** Max time dispose waits for session queues (ms). Defaults to OPENCODE_PLUGIN_DISPOSE_TIMEOUT_MS. */
  disposeTimeoutMs?: number;
}

export type OpenCodePlugin = (
  input: OpenCodePluginInput,
  options?: OpenCodePluginOptions,
) => Promise<OpenCodeHooks>;

export const createOpenCodePlugin: OpenCodePlugin = async (input, options = {}) => {
  const state = new OpenCodeSessionState(options.stateDir);
  const tools = options.tools ?? createMemoryTools();
  const log = options.log ?? ((message: string) => process.stderr.write(`[memory-tencentdb][opencode] ${message}\n`));
  const disposeTimeoutMs = options.disposeTimeoutMs ?? OPENCODE_PLUGIN_DISPOSE_TIMEOUT_MS;
  const sessionQueues = new Map<string, Promise<void>>();
  let closing = false;

  const enqueue = (sessionId: string, operation: () => Promise<void>): Promise<void> => {
    if (closing) return Promise.resolve();
    const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    sessionQueues.set(sessionId, next);
    const cleanup = () => {
      if (sessionQueues.get(sessionId) === next) sessionQueues.delete(sessionId);
    };
    void next.then(cleanup, cleanup);
    return next;
  };

  const settleSessionQueues = async (timeoutMs: number): Promise<"settled" | "timeout"> => {
    const pending = [...sessionQueues.values()];
    if (pending.length === 0) return "settled";
    // Fail-open on individual queue rejections so dispose still completes.
    const allSettled = Promise.all(pending.map((p) => p.catch(() => undefined))).then(() => "settled" as const);
    if (timeoutMs <= 0) {
      await allSettled;
      return "settled";
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        allSettled,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const releaseRecallFailOpen = async (sessionId: string, userMessageId: string) => {
    try {
      await state.releaseRecall(sessionId, userMessageId);
    } catch (error) {
      log(`recall claim release failed open: ${errorMessage(error)}`);
    }
  };

  const captureIdleSession = async (sessionId: string) => {
    if (await state.hasSessionError(sessionId)) return;

    const response = await input.client.session.messages({
      path: { id: sessionId },
      query: { directory: input.directory },
      throwOnError: true,
    });
    const turn = findLatestCompleteTurn(response.data ?? []);
    if (!turn) return;
    if (!await state.beginCapture(sessionId, turn.user.info.id, turn.assistant.info.id)) return;

    try {
      await tools.capture({
        userContent: turn.userContent,
        assistantContent: turn.assistantContent,
        sessionKey: opencodeSessionKey(sessionId),
        sessionId,
        messages: [
          {
            id: `opencode:${sessionId}:${turn.user.info.id}:user`,
            role: "user",
            content: turn.userContent,
          },
          {
            id: `opencode:${sessionId}:${turn.assistant.info.id}:assistant`,
            role: "assistant",
            content: turn.assistantContent,
          },
        ],
      });
      await state.markCaptured(sessionId, turn.user.info.id, turn.assistant.info.id);
    } catch (error) {
      await state.releaseCapture(sessionId, turn.user.info.id, turn.assistant.info.id);
      log(`capture failed open: ${errorMessage(error)}`);
    }
  };

  return {
    "chat.message": async (hookInput, output) => {
      if (closing) return;
      if (output.message.role !== "user") return;
      const sessionId = hookInput.sessionID || output.message.sessionID;
      const userMessageId = hookInput.messageID || output.message.id;
      if (!sessionId || !userMessageId) return;
      await enqueue(sessionId, async () => {
        const query = extractVisibleText(output.parts);
        try {
          await state.clearSessionError(sessionId);
          if (!query || !await state.beginRecall(sessionId, userMessageId)) return;
          const result = await tools.recall({ query, sessionKey: opencodeSessionKey(sessionId) });
          const context = result.context.trim();
          await state.saveRecall(sessionId, userMessageId, context);
        } catch (error) {
          await releaseRecallFailOpen(sessionId, userMessageId);
          log(`chat message failed open: ${errorMessage(error)}`);
        }
      });
    },

    "experimental.chat.messages.transform": async (_hookInput, output) => {
      if (closing) return;
      const user = output.messages.findLast((message) => message.info.role === "user");
      if (!user) return;
      try {
        await enqueue(user.info.sessionID, () => state.setActiveRecall(user.info.sessionID, user.info.id));
      } catch (error) {
        log(`messages transform failed open: ${errorMessage(error)}`);
      }
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      if (closing) return;
      if (!hookInput.sessionID) return;
      try {
        const recall = await state.consumeRecall(hookInput.sessionID);
        if (!recall?.context.trim()) return;
        output.system.push(`<relevant-memories>\n${recall.context.trim()}\n</relevant-memories>`);
      } catch (error) {
        log(`system transform failed open: ${errorMessage(error)}`);
      }
    },

    event: async ({ event }) => {
      if (closing) return;
      const sessionId = eventSessionId(event);
      if (event.type === "session.error") {
        if (!sessionId) {
          log("session error without session id ignored");
          return;
        }
        await enqueue(sessionId, async () => {
          try {
            await state.markSessionError(sessionId);
          } catch (error) {
            log(`session error state failed open: ${errorMessage(error)}`);
          }
        });
        return;
      }

      if (event.type === "session.deleted") {
        if (!sessionId) return;
        await enqueue(sessionId, async () => {
          try {
            if (!await state.beginSessionEnd(sessionId)) return;
            await tools.endSession({ sessionKey: opencodeSessionKey(sessionId) });
            await state.markSessionEnded(sessionId);
            await state.clearSession(sessionId);
          } catch (error) {
            try {
              await state.releaseSessionEnd(sessionId);
            } catch (releaseError) {
              log(`session end claim release failed open: ${errorMessage(releaseError)}`);
            }
            log(`session end failed open: ${errorMessage(error)}`);
          }
        });
        return;
      }

      const isIdle = event.type === "session.idle"
        || (event.type === "session.status" && isIdleStatus(event.properties.status));
      if (!isIdle || !sessionId) return;
      await enqueue(sessionId, async () => {
        try {
          await captureIdleSession(sessionId);
        } catch (error) {
          log(`idle capture failed open: ${errorMessage(error)}`);
        }
      });
    },

    dispose: async () => {
      if (closing) {
        // Concurrent dispose: still wait for whatever is already in flight (with timeout).
        const result = await settleSessionQueues(disposeTimeoutMs);
        if (result === "timeout") {
          log(`dispose timed out after ${disposeTimeoutMs}ms waiting for session queues`);
        }
        return;
      }
      closing = true;
      const result = await settleSessionQueues(disposeTimeoutMs);
      if (result === "timeout") {
        log(`dispose timed out after ${disposeTimeoutMs}ms waiting for session queues`);
      }
    },
  };
};

export function extractVisibleText(parts: Array<OpenCodeTextPart | Record<string, unknown>>): string {
  return parts
    .filter((part): part is OpenCodeTextPart => (
      part.type === "text"
      && typeof part.text === "string"
      && !part.ignored
      && !part.synthetic
      && part.text.trim().length > 0
    ))
    .map((part) => part.text.trim())
    .join("\n");
}

export function findLatestCompleteTurn(messages: OpenCodeMessage[]) {
  const assistant = messages.findLast((message) => message.info.role === "assistant");
  if (
    !assistant
    || !assistant.info.parentID
    || assistant.info.error
    || !assistant.info.time?.completed
    || assistant.info.finish === "tool-calls"
  ) return undefined;

  const assistantContent = extractVisibleText(assistant.parts);
  if (!assistantContent) return undefined;
  const user = messages.findLast((message) => (
    message.info.role === "user" && message.info.id === assistant.info.parentID
  ));
  if (!user) return undefined;
  const userContent = extractVisibleText(user.parts);
  if (!userContent) return undefined;
  return { user, assistant, userContent, assistantContent };
}

function eventSessionId(event: OpenCodeEvent): string | undefined {
  if (typeof event.properties.sessionID === "string") return event.properties.sessionID;
  const info = event.properties.info;
  if (isRecord(info) && typeof info.id === "string") return info.id;
  return undefined;
}

function isIdleStatus(status: unknown): boolean {
  return isRecord(status) && status.type === "idle";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}