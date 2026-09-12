const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 5_000;
const RECALL_MARKER = "[TencentDB Agent Memory — recalled context]";

function flag(value) {
  return (
    typeof value === "string" &&
    ["1", "true", "yes"].includes(value.toLowerCase())
  );
}

export function readConfig(env = process.env) {
  const parsedTimeout = Number.parseInt(env.MEMORY_TENCENTDB_TIMEOUT_MS ?? "", 10);
  return {
    gatewayUrl: env.MEMORY_TENCENTDB_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL,
    apiKey:
      env.MEMORY_TENCENTDB_GATEWAY_API_KEY?.trim() ||
      env.TDAI_GATEWAY_API_KEY?.trim() ||
      undefined,
    timeoutMs:
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : DEFAULT_TIMEOUT_MS,
    debug: flag(env.MEMORY_TENCENTDB_DEBUG),
  };
}

export class GatewayClient {
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onError = options.onError;
  }

  recall(query, sessionKey, signal) {
    return this.post("/recall", { query, session_key: sessionKey }, signal);
  }

  capture(userContent, assistantContent, sessionKey, signal) {
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

  async post(path, body, outerSignal) {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = outerSignal
      ? AbortSignal.any([outerSignal, timeoutSignal])
      : timeoutSignal;
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        this.onError?.(path, new Error(`HTTP ${response.status}`));
        return null;
      }
      return await response.json();
    } catch (error) {
      this.onError?.(path, error);
      return null;
    }
  }
}

export function makeSessionKey(conversationId) {
  return `cline_${conversationId}`;
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function latestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return textFromContent(message.content).trim();
  }
  return "";
}

export function formatRecallContext(context) {
  return (
    `${RECALL_MARKER}\n` +
    "The following long-term memories may be relevant. Treat them as background " +
    "knowledge from earlier sessions; the current conversation takes precedence " +
    `when they conflict.\n\n${context}`
  );
}

export function injectRecallIntoMessages(messages, recalledContext) {
  if (!recalledContext || !Array.isArray(messages)) return messages;
  const formatted = formatRecallContext(recalledContext);
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return messages;
  const message = messages[userIndex];
  const content = Array.isArray(message.content) ? message.content : [];
  if (
    content.some(
      (part) =>
        part?.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes(RECALL_MARKER),
    )
  ) {
    return messages;
  }
  const result = [...messages];
  result[userIndex] = {
    ...message,
    content: [...content, { type: "text", text: `\n\n${formatted}` }],
  };
  return result;
}

export function createMemoryRuntime(options = {}) {
  const config = options.config ?? readConfig(options.env);
  const log = options.log ?? ((message) => console.error(message));
  const client =
    options.client ??
    new GatewayClient({
      baseUrl: config.gatewayUrl,
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      onError(operation, error) {
        if (config.debug) {
          const detail = error instanceof Error ? error.message : String(error);
          log(`[tdai-memory] ${operation} failed: ${detail}`);
        }
      },
    });

  return {
    config,

    async recall(query, conversationId, signal) {
      if (!query || !conversationId) return "";
      const response = await client.recall(
        query,
        makeSessionKey(conversationId),
        signal,
      );
      return typeof response?.context === "string" ? response.context : "";
    },

    async capture(userContent, assistantContent, conversationId, signal) {
      if (!userContent || !assistantContent || !conversationId) return null;
      return client.capture(
        userContent,
        assistantContent,
        makeSessionKey(conversationId),
        signal,
      );
    },
  };
}
