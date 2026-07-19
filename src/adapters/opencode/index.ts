import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import {
  GatewayMemoryClient,
  createGatewayPlatformAdapter,
  type GatewayPlatformAdapter,
} from "../gateway-client/index.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const LOG_SERVICE = "memory-tencentdb-opencode";

export interface OpenCodeMemoryPluginOptions {
  gatewayUrl?: string;
  apiKey?: string;
  userId?: string;
  sessionKeyPrefix?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test hook for deterministic OpenCode part ids. */
  partIdFactory?: () => string;
}

export interface OpenCodeTextPart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
}

export interface OpenCodeMessage {
  id?: string;
  sessionID?: string;
  role?: string;
  parentID?: string;
  time?: { completed?: number };
  error?: unknown;
}

export interface OpenCodePluginContext {
  directory: string;
  worktree?: string;
  client?: {
    app?: {
      log?: (request: {
        body: {
          service: string;
          level: "debug" | "info" | "warn" | "error";
          message: string;
          extra?: Record<string, unknown>;
        };
      }) => Promise<unknown>;
    };
  };
}

export interface OpenCodePluginHooks {
  "chat.message"?: (
    input: { sessionID: string; messageID?: string },
    output: { message: OpenCodeMessage; parts: OpenCodeTextPart[] },
  ) => Promise<void>;
  event?: (input: {
    event: { type: string; properties?: Record<string, any> };
  }) => Promise<void>;
  dispose?: () => Promise<void>;
}

export type OpenCodeMemoryPlugin = (
  context: OpenCodePluginContext,
) => Promise<OpenCodePluginHooks>;

interface PendingTurn {
  userMessageID: string;
  sessionID: string;
  userText: string;
  createdAt: number;
}

interface AssistantInfo {
  messageID: string;
  sessionID: string;
  parentID?: string;
  completed: boolean;
  failed: boolean;
}

interface MessageMetadata {
  role: string;
  sessionID: string;
}

function configuredValue(option: string | undefined, envName: string, fallback = ""): string {
  const value = option ?? process.env[envName];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function workspaceIdentity(context: Pick<OpenCodePluginContext, "directory" | "worktree">): string {
  const root = context.worktree || context.directory || process.cwd();
  const name = basename(root) || "workspace";
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `${name}:${digest}`;
}

export function buildOpenCodeSessionKey(input: {
  sessionID: string;
  directory: string;
  worktree?: string;
  prefix?: string;
}): string {
  const prefix = input.prefix?.replace(/:+$/, "") || `opencode:${workspaceIdentity(input)}`;
  return `${prefix}:${input.sessionID}`;
}

export function extractOpenCodePrompt(parts: OpenCodeTextPart[]): string {
  return parts
    .filter((part) => part?.type === "text" && part.synthetic !== true)
    .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function defaultPartId(): string {
  return `prt_${Date.now().toString(36)}${randomBytes(10).toString("hex")}`;
}

function recallBlock(context: string): string {
  return [
    '<relevant-memories source="memory-tencentdb">',
    context.trim(),
    "</relevant-memories>",
  ].join("\n");
}

/**
 * Create an OpenCode plugin backed by the shared Gateway adapter from #316.
 * Gateway failures are intentionally fail-open so memory cannot block a turn.
 */
export function createOpenCodeMemoryPlugin(
  options: OpenCodeMemoryPluginOptions = {},
): OpenCodeMemoryPlugin {
  return async (context): Promise<OpenCodePluginHooks> => {
    const gatewayUrl = configuredValue(
      options.gatewayUrl,
      "MEMORY_TENCENTDB_GATEWAY_URL",
      DEFAULT_GATEWAY_URL,
    );
    const apiKey = configuredValue(
      options.apiKey,
      "MEMORY_TENCENTDB_GATEWAY_API_KEY",
    );
    const userId = configuredValue(options.userId, "MEMORY_TENCENTDB_USER_ID");
    const sessionKeyPrefix = configuredValue(
      options.sessionKeyPrefix,
      "MEMORY_TENCENTDB_SESSION_KEY_PREFIX",
    );
    const makePartId = options.partIdFactory ?? defaultPartId;
    const client = new GatewayMemoryClient({
      baseUrl: gatewayUrl,
      apiKey: apiKey || undefined,
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });

    const adapters = new Map<string, GatewayPlatformAdapter>();
    const activeSessions = new Set<string>();
    const pendingTurns = new Map<string, PendingTurn>();
    const latestTurnBySession = new Map<string, string>();
    const assistantInfo = new Map<string, AssistantInfo>();
    const messageMetadata = new Map<string, MessageMetadata>();
    const textPartsByMessage = new Map<string, Map<string, string>>();
    const captureInFlight = new Map<string, Promise<boolean>>();

    const log = async (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      extra?: Record<string, unknown>,
    ): Promise<void> => {
      try {
        await context.client?.app?.log?.({
          body: { service: LOG_SERVICE, level, message, extra },
        });
      } catch {
        // OpenCode logging is best-effort and must not affect a turn.
      }
    };

    const sessionKeyFor = (sessionID: string): string =>
      buildOpenCodeSessionKey({
        sessionID,
        directory: context.directory,
        worktree: context.worktree,
        prefix: sessionKeyPrefix || undefined,
      });

    const adapterFor = (sessionID: string): GatewayPlatformAdapter => {
      const existing = adapters.get(sessionID);
      if (existing) return existing;
      const adapter = createGatewayPlatformAdapter({
        client,
        platform: "opencode",
        resolveContext: () => ({
          sessionKey: sessionKeyFor(sessionID),
          sessionId: sessionID,
          userId: userId || undefined,
        }),
      });
      adapters.set(sessionID, adapter);
      return adapter;
    };

    const refreshLatestTurn = (sessionID: string): void => {
      let latest: PendingTurn | undefined;
      for (const turn of pendingTurns.values()) {
        if (turn.sessionID !== sessionID) continue;
        if (!latest || turn.createdAt >= latest.createdAt) latest = turn;
      }
      if (latest) latestTurnBySession.set(sessionID, latest.userMessageID);
      else latestTurnBySession.delete(sessionID);
    };

    const removeTurn = (turn: PendingTurn): void => {
      pendingTurns.delete(turn.userMessageID);
      messageMetadata.delete(turn.userMessageID);
      textPartsByMessage.delete(turn.userMessageID);
      if (latestTurnBySession.get(turn.sessionID) === turn.userMessageID) {
        refreshLatestTurn(turn.sessionID);
      }
    };

    const assistantTextFor = (messageID: string): string =>
      [...(textPartsByMessage.get(messageID)?.values() ?? [])]
        .map((text) => text.trim())
        .filter(Boolean)
        .join("\n")
        .trim();

    const turnForAssistant = (info: AssistantInfo): PendingTurn | undefined => {
      if (info.parentID) {
        const exact = pendingTurns.get(info.parentID);
        if (exact) return exact;
      }
      const fallbackID = latestTurnBySession.get(info.sessionID);
      return fallbackID ? pendingTurns.get(fallbackID) : undefined;
    };

    const captureAssistant = (info: AssistantInfo): Promise<boolean> => {
      const existing = captureInFlight.get(info.messageID);
      if (existing) return existing;

      const capture = (async (): Promise<boolean> => {
        if (!info.completed || info.failed) return false;
        const turn = turnForAssistant(info);
        const assistantText = assistantTextFor(info.messageID);
        if (!turn || !assistantText) return false;

        try {
          await adapterFor(info.sessionID).captureTurn({
            userText: turn.userText,
            assistantText,
            messages: [
              { role: "user", content: turn.userText, timestamp: turn.createdAt },
              { role: "assistant", content: assistantText, timestamp: Date.now() },
            ],
          });
          removeTurn(turn);
          assistantInfo.delete(info.messageID);
          messageMetadata.delete(info.messageID);
          textPartsByMessage.delete(info.messageID);
          await log("debug", "Captured completed OpenCode turn", {
            sessionID: info.sessionID,
          });
          return true;
        } catch (error) {
          await log("warn", "Failed to capture OpenCode turn", {
            sessionID: info.sessionID,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      })().finally(() => {
        captureInFlight.delete(info.messageID);
      });

      captureInFlight.set(info.messageID, capture);
      return capture;
    };

    const captureCompletedForSession = async (sessionID: string): Promise<void> => {
      const completed = [...assistantInfo.values()].filter(
        (info) => info.sessionID === sessionID && info.completed && !info.failed,
      );
      for (const info of completed) await captureAssistant(info);
    };

    const discardSessionTurns = (sessionID: string): void => {
      for (const turn of [...pendingTurns.values()]) {
        if (turn.sessionID === sessionID) pendingTurns.delete(turn.userMessageID);
      }
      for (const info of [...assistantInfo.values()]) {
        if (info.sessionID !== sessionID) continue;
        assistantInfo.delete(info.messageID);
        textPartsByMessage.delete(info.messageID);
      }
      for (const [messageID, metadata] of [...messageMetadata]) {
        if (metadata.sessionID !== sessionID) continue;
        messageMetadata.delete(messageID);
        textPartsByMessage.delete(messageID);
      }
      latestTurnBySession.delete(sessionID);
    };

    const clearSessionState = (sessionID: string): void => {
      discardSessionTurns(sessionID);
      adapters.delete(sessionID);
      activeSessions.delete(sessionID);
    };

    const finishSession = async (sessionID: string): Promise<void> => {
      await captureCompletedForSession(sessionID);
      try {
        await adapterFor(sessionID).endSession();
      } catch (error) {
        await log("warn", "Failed to flush OpenCode session", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearSessionState(sessionID);
      }
    };

    const chatMessage: NonNullable<OpenCodePluginHooks["chat.message"]> = async (
      input,
      output,
    ): Promise<void> => {
      const userText = extractOpenCodePrompt(output.parts);
      const userMessageID = output.message.id || input.messageID;
      if (!userText || !userMessageID) return;

      activeSessions.add(input.sessionID);
      pendingTurns.set(userMessageID, {
        userMessageID,
        sessionID: input.sessionID,
        userText,
        createdAt: Date.now(),
      });
      messageMetadata.set(userMessageID, {
        role: "user",
        sessionID: input.sessionID,
      });
      latestTurnBySession.set(input.sessionID, userMessageID);

      try {
        const recalled = await adapterFor(input.sessionID).prefetch(userText);
        const contextText = recalled.context?.trim();
        if (!contextText) return;
        output.parts.unshift({
          id: makePartId(),
          sessionID: input.sessionID,
          messageID: userMessageID,
          type: "text",
          text: recallBlock(contextText),
          synthetic: true,
        });
      } catch (error) {
        await log("warn", "Failed to recall memory for OpenCode turn", {
          sessionID: input.sessionID,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const event: NonNullable<OpenCodePluginHooks["event"]> = async ({ event }): Promise<void> => {
      try {
        const properties = event.properties ?? {};

        if (event.type === "message.updated") {
          const message = properties.info as OpenCodeMessage | undefined;
          if (!message?.id || !message.role || !message.sessionID) return;
          messageMetadata.set(message.id, {
            role: message.role,
            sessionID: message.sessionID,
          });
          if (message.role !== "assistant") {
            textPartsByMessage.delete(message.id);
            return;
          }
          const info: AssistantInfo = {
            messageID: message.id,
            sessionID: message.sessionID,
            parentID: message.parentID,
            completed: Boolean(message.time?.completed),
            failed: Boolean(message.error),
          };
          activeSessions.add(message.sessionID);
          assistantInfo.set(message.id, info);
          if (info.completed) await captureAssistant(info);
          return;
        }

        if (event.type === "message.part.updated") {
          const part = properties.part as OpenCodeTextPart | undefined;
          if (
            !part?.messageID ||
            !part.sessionID ||
            part.type !== "text" ||
            part.synthetic === true ||
            typeof part.text !== "string"
          ) return;
          const metadata = messageMetadata.get(part.messageID);
          if (metadata && metadata.role !== "assistant") return;
          const parts = textPartsByMessage.get(part.messageID) ?? new Map<string, string>();
          parts.set(part.id || "text", part.text);
          textPartsByMessage.set(part.messageID, parts);
          const info = assistantInfo.get(part.messageID);
          if (info?.completed) await captureAssistant(info);
          return;
        }

        if (event.type === "message.removed") {
          const messageID = String(properties.messageID ?? "");
          if (!messageID) return;
          const turn = pendingTurns.get(messageID);
          if (turn) removeTurn(turn);
          assistantInfo.delete(messageID);
          messageMetadata.delete(messageID);
          textPartsByMessage.delete(messageID);
          return;
        }

        if (event.type === "message.part.removed") {
          const messageID = String(properties.messageID ?? "");
          const partID = String(properties.partID ?? "");
          if (messageID && partID) textPartsByMessage.get(messageID)?.delete(partID);
          return;
        }

        const idleSessionID =
          event.type === "session.idle"
            ? String(properties.sessionID ?? "")
            : event.type === "session.status" && properties.status?.type === "idle"
              ? String(properties.sessionID ?? "")
              : "";
        if (idleSessionID) {
          await captureCompletedForSession(idleSessionID);
          return;
        }

        if (event.type === "session.error") {
          const sessionID = String(properties.sessionID ?? "");
          if (sessionID) discardSessionTurns(sessionID);
          return;
        }

        if (event.type === "session.deleted") {
          const sessionID = String(properties.sessionID ?? properties.info?.id ?? "");
          if (sessionID) await finishSession(sessionID);
        }
      } catch (error) {
        await log("warn", "OpenCode memory event handler failed", {
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    return {
      "chat.message": chatMessage,
      event,
      dispose: async () => {
        await Promise.all([...activeSessions].map((sessionID) => finishSession(sessionID)));
      },
    };
  };
}
