/**
 * TencentDB Agent Memory adapter for Xiaomi MiMo Code.
 *
 * Lifecycle mapping:
 *
 *   chat.message                         -> POST /recall
 *   experimental.chat.system.transform  -> inject recalled context
 *   session.post (main agent)            -> POST /capture
 *   session.deleted                      -> POST /session/end
 *
 * Gateway access is best-effort. A timeout, network failure, invalid response,
 * or non-2xx status never blocks the MiMo Code session.
 */

import type {
  Plugin,
  PluginModule,
  TrajectoryMessage,
} from "@mimo-ai/plugin";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 5_000;
const RECALL_MARKER = "[TencentDB Agent Memory — recalled context]";

export interface GatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  onError?: (operation: string, error: unknown) => void;
}

export interface MemoryRuntime {
  recall(
    query: string,
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<string>;
  capture(
    userContent: string,
    assistantContent: string,
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  sessionEnd(sessionID: string, signal?: AbortSignal): Promise<unknown>;
}

export function readConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const parsedTimeout = Number.parseInt(
    env.MEMORY_TENCENTDB_TIMEOUT_MS ?? "",
    10,
  );
  return {
    gatewayUrl:
      env.MEMORY_TENCENTDB_GATEWAY_URL?.trim() ||
      DEFAULT_GATEWAY_URL,
    apiKey:
      env.MEMORY_TENCENTDB_GATEWAY_API_KEY?.trim() ||
      env.TDAI_GATEWAY_API_KEY?.trim() ||
      undefined,
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : DEFAULT_TIMEOUT_MS,
    debug: ["1", "true", "yes"].includes(
      env.MEMORY_TENCENTDB_DEBUG?.toLowerCase() ?? "",
    ),
  };
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly onError?: (operation: string, error: unknown) => void;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onError = options.onError;
  }

  recall(query: string, sessionKey: string, signal?: AbortSignal) {
    return this.post<{ context?: unknown }>(
      "/recall",
      { query, session_key: sessionKey },
      signal,
    );
  }

  capture(
    userContent: string,
    assistantContent: string,
    sessionKey: string,
    signal?: AbortSignal,
  ) {
    return this.post(
      "/capture",
      {
        user_content: userContent,
        assistant_content: assistantContent,
        session_key: sessionKey,
      },
      signal,
    );
  }

  sessionEnd(sessionKey: string, signal?: AbortSignal) {
    return this.post("/session/end", { session_key: sessionKey }, signal);
  }

  private async post<T = unknown>(
    endpoint: string,
    body: unknown,
    outerSignal?: AbortSignal,
  ): Promise<T | null> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = outerSignal
      ? AbortSignal.any([outerSignal, timeoutSignal])
      : timeoutSignal;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        this.onError?.(endpoint, new Error(`HTTP ${response.status}`));
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.onError?.(endpoint, error);
      return null;
    }
  }
}

export function makeSessionKey(sessionID: string) {
  return `mimo_${sessionID}`;
}

export function textFromParts(
  parts:
    | Array<{
        type?: string;
        text?: string;
        synthetic?: boolean;
        ignored?: boolean;
      }>
    | undefined,
) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (part) =>
        part.type === "text" &&
        typeof part.text === "string" &&
        part.synthetic !== true &&
        part.ignored !== true,
    )
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function latestTrajectoryText(
  trajectory: TrajectoryMessage[] | undefined,
  role: "user" | "assistant",
) {
  if (!Array.isArray(trajectory)) return "";
  for (let index = trajectory.length - 1; index >= 0; index -= 1) {
    const message = trajectory[index];
    if (message.role !== role) continue;
    const text = textFromParts(message.parts);
    if (text) return text;
  }
  return "";
}

export function formatRecallContext(context: string) {
  return (
    `${RECALL_MARKER}\n` +
    "The following long-term memories may be relevant to the current request. " +
    "Treat them as background knowledge from earlier sessions. The current " +
    "conversation and repository state take precedence when they conflict.\n\n" +
    context
  );
}

export function createMemoryRuntime(options: {
  config?: ReturnType<typeof readConfig>;
  client?: GatewayClient;
  onError?: (operation: string, error: unknown) => void;
} = {}): MemoryRuntime {
  const config = options.config ?? readConfig();
  const client =
    options.client ??
    new GatewayClient({
      baseUrl: config.gatewayUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      onError: options.onError,
    });

  return {
    async recall(query, sessionID, signal) {
      if (!query || !sessionID) return "";
      const response = await client.recall(
        query,
        makeSessionKey(sessionID),
        signal,
      );
      return typeof response?.context === "string" ? response.context : "";
    },

    capture(userContent, assistantContent, sessionID, signal) {
      if (!userContent || !assistantContent || !sessionID) {
        return Promise.resolve(null);
      }
      return client.capture(
        userContent,
        assistantContent,
        makeSessionKey(sessionID),
        signal,
      );
    },

    sessionEnd(sessionID, signal) {
      if (!sessionID) return Promise.resolve(null);
      return client.sessionEnd(makeSessionKey(sessionID), signal);
    },
  };
}

export function createMimoMemoryPlugin(options: {
  runtime?: MemoryRuntime;
} = {}): Plugin {
  return async (input) => {
    const config = readConfig();
    const reportError = (operation: string, error: unknown) => {
      if (!config.debug) return;
      const detail = error instanceof Error ? error.message : String(error);
      void Promise.resolve(
        input.client.app.log({
          body: {
            service: "tencentdb-agent-memory",
            level: "warn",
            message: `${operation} failed; continuing without memory`,
            extra: { detail },
          },
        }),
      ).catch(() => {});
    };
    const runtime =
      options.runtime ??
      createMemoryRuntime({
        config,
        onError: reportError,
      });
    const recalledBySession = new Map<string, string>();

    return {
      "chat.message": async (hookInput, output) => {
        const query = textFromParts(output.parts);
        if (!query) return;

        try {
          const context = await runtime.recall(query, hookInput.sessionID);
          if (context) recalledBySession.set(hookInput.sessionID, context);
          else recalledBySession.delete(hookInput.sessionID);
        } catch (error) {
          recalledBySession.delete(hookInput.sessionID);
          reportError("/recall", error);
        }
      },

      "experimental.chat.system.transform": async (hookInput, output) => {
        if (!hookInput.sessionID) return;
        const context = recalledBySession.get(hookInput.sessionID);
        if (!context) return;
        if (output.system.some((section) => section.includes(RECALL_MARKER))) {
          return;
        }
        output.system.push(formatRecallContext(context));
      },

      "session.post": async (hookInput) => {
        recalledBySession.delete(hookInput.sessionID);
        if (hookInput.agentID !== "main") return;
        if (hookInput.outcome !== "completed") return;

        const userContent = latestTrajectoryText(
          hookInput.trajectory,
          "user",
        );
        const assistantContent =
          hookInput.finalText?.trim() ||
          latestTrajectoryText(hookInput.trajectory, "assistant");
        if (!userContent || !assistantContent) return;

        try {
          await runtime.capture(
            userContent,
            assistantContent,
            hookInput.sessionID,
          );
        } catch (error) {
          reportError("/capture", error);
        }
      },

      event: async ({ event }) => {
        if (event.type !== "session.deleted") return;
        recalledBySession.delete(event.properties.info.id);
        try {
          await runtime.sessionEnd(event.properties.info.id);
        } catch (error) {
          reportError("/session/end", error);
        }
      },
    };
  };
}

const plugin: PluginModule = {
  id: "tencentdb-agent-memory",
  server: createMimoMemoryPlugin(),
};

export default plugin;
