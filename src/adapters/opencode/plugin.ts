import { createMemoryTools, type MemoryTools } from "../mcp/tools.js";
import { ExternalAdapterOperationStore } from "../sdk/operation-store.js";
import { createAdapterRuntime } from "../sdk/runtime.js";
import type { AdapterRuntime, PlatformAdapter } from "../sdk/types.js";
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

export class OpenCodePlatformAdapter implements PlatformAdapter<OpenCodeHooks> {
  readonly platform = "opencode";

  constructor(
    private readonly input: OpenCodePluginInput,
    private readonly options: OpenCodePluginOptions = {},
  ) {}

  create(runtime: AdapterRuntime): Promise<OpenCodeHooks> {
    return createOpenCodeHooks(this.input, this.options, runtime);
  }
}

export const createOpenCodePlugin: OpenCodePlugin = async (input, options = {}) => {
  const tools = options.tools ?? createMemoryTools();
  const log = options.log ?? ((message: string) => process.stderr.write(`[memory-tencentdb][opencode] ${message}\n`));
  const runtime = createAdapterRuntime({
    platform: "opencode",
    client: tools,
    operationStore: new ExternalAdapterOperationStore(),
    log: (message) => log(message
      .replace("[opencode] recall failed open:", "chat message failed open:")
      .replace(/^\[opencode\] /, "")),
  });
  return new OpenCodePlatformAdapter(input, { ...options, tools, log }).create(runtime);
};

async function createOpenCodeHooks(
  input: OpenCodePluginInput,
  options: OpenCodePluginOptions,
  runtime: AdapterRuntime,
): Promise<OpenCodeHooks> {
  const state = new OpenCodeSessionState(options.stateDir);
  const log = options.log ?? ((message: string) => process.stderr.write(`[memory-tencentdb][opencode] ${message}\n`));
  const disposeTimeoutMs = options.disposeTimeoutMs ?? OPENCODE_PLUGIN_DISPOSE_TIMEOUT_MS;
  let closing = false;

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
      const result = await runtime.capture({
        operationId: `${turn.user.info.id}\0${turn.assistant.info.id}`,
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
      if (result) await state.markCaptured(sessionId, turn.user.info.id, turn.assistant.info.id);
      else await state.releaseCapture(sessionId, turn.user.info.id, turn.assistant.info.id);
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
      await runtime.runExclusive(sessionId, async () => {
        const query = extractVisibleText(output.parts);
        try {
          await state.clearSessionError(sessionId);
          if (!query || !await state.beginRecall(sessionId, userMessageId)) return;
          const outcome = await runtime.recallOutcome({ query, sessionKey: opencodeSessionKey(sessionId) });
          if (!outcome.ok) {
            await releaseRecallFailOpen(sessionId, userMessageId);
            return;
          }
          await state.saveRecall(sessionId, userMessageId, outcome.result?.context ?? "");
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
        await runtime.runExclusive(user.info.sessionID, () => state.setActiveRecall(user.info.sessionID, user.info.id));
      } catch (error) {
        log(`messages transform failed open: ${errorMessage(error)}`);
      }
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      if (closing) return;
      if (!hookInput.sessionID) return;
      try {
        await runtime.runExclusive(hookInput.sessionID, async () => {
          const recall = await state.consumeRecall(hookInput.sessionID);
          if (!recall?.context.trim()) return;
          output.system.push(`<relevant-memories>\n${recall.context.trim()}\n</relevant-memories>`);
        });
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
        await runtime.runExclusive(sessionId, async () => {
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
        await runtime.runExclusive(sessionId, async () => {
          try {
            if (!await state.beginSessionEnd(sessionId)) return;
            const result = await runtime.endSession({
              operationId: sessionId,
              sessionKey: opencodeSessionKey(sessionId),
            });
            if (result) {
              await state.markSessionEnded(sessionId);
              await state.clearSession(sessionId);
            } else {
              await state.releaseSessionEnd(sessionId);
            }
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
      await runtime.runExclusive(sessionId, async () => {
        try {
          await captureIdleSession(sessionId);
        } catch (error) {
          log(`idle capture failed open: ${errorMessage(error)}`);
        }
      });
    },

    dispose: async () => {
      closing = true;
      await runtime.dispose(disposeTimeoutMs);
    },
  };
}

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