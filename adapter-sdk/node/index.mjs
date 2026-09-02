import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
export const DEFAULT_TIMEOUT_MS = 10_000;

function env(name, fallback = "") {
  return (process.env[name] || fallback).trim();
}

export function defaultGatewayUrl() {
  return (
    env("TDAI_GATEWAY_URL") ||
    env("MEMORY_TENCENTDB_GATEWAY_URL") ||
    DEFAULT_GATEWAY_URL
  ).replace(/\/+$/, "");
}

export function defaultGatewayApiKey() {
  return env("TDAI_GATEWAY_API_KEY") || env("MEMORY_TENCENTDB_GATEWAY_API_KEY");
}

export function defaultTimeoutMs() {
  const raw = env("TDAI_GATEWAY_TIMEOUT_MS") || env("TDAI_ADAPTER_TIMEOUT_MS");
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export class TdaiGatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TdaiGatewayError";
    this.route = options.route;
    this.status = options.status;
    this.body = options.body;
  }
}

export class TdaiGatewayClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || defaultGatewayUrl()).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? defaultGatewayApiKey();
    this.timeoutMs = options.timeoutMs || defaultTimeoutMs();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new TdaiGatewayError("No fetch implementation available for TdaiGatewayClient");
    }
  }

  async post(route, payload) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }
      if (!response.ok) {
        throw new TdaiGatewayError(`${route} returned HTTP ${response.status}: ${text.slice(0, 300)}`, {
          route,
          status: response.status,
          body: text,
        });
      }
      return parsed && typeof parsed === "object" ? parsed : { data: parsed };
    } catch (error) {
      if (error instanceof TdaiGatewayError) throw error;
      throw new TdaiGatewayError(`${route} request failed: ${error instanceof Error ? error.message : String(error)}`, {
        route,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  recall({ query, sessionKey, userId }) {
    const payload = { query, session_key: sessionKey };
    if (userId) payload.user_id = userId;
    return this.post("/recall", payload);
  }

  capture({ userText, assistantText, sessionKey, sessionId, userId, messages }) {
    const payload = {
      user_content: userText,
      assistant_content: assistantText,
      session_key: sessionKey,
    };
    if (sessionId) payload.session_id = sessionId;
    if (userId) payload.user_id = userId;
    payload.messages = messages || [
      { role: "user", content: userText },
      { role: "assistant", content: assistantText },
    ];
    return this.post("/capture", payload);
  }

  searchMemories({ query, limit }) {
    const payload = { query };
    if (limit != null) payload.limit = limit;
    return this.post("/search/memories", payload);
  }

  searchConversations({ query, limit, sessionKey }) {
    const payload = { query };
    if (limit != null) payload.limit = limit;
    if (sessionKey) payload.session_key = sessionKey;
    return this.post("/search/conversations", payload);
  }

  endSession({ sessionKey, userId }) {
    const payload = { session_key: sessionKey };
    if (userId) payload.user_id = userId;
    return this.post("/session/end", payload);
  }
}

export class InMemoryTurnStateStore {
  constructor(initialState = {}) {
    this.state = { ...initialState };
  }

  async readAll() {
    return { ...this.state };
  }

  async writeAll(state) {
    this.state = { ...state };
  }

  async readSession(sessionKey) {
    const state = await this.readAll();
    return { ...(state[sessionKey] || {}) };
  }

  async mergeSession(sessionKey, patch) {
    const state = await this.readAll();
    state[sessionKey] = { ...(state[sessionKey] || {}), ...patch };
    await this.writeAll(state);
    return state[sessionKey];
  }

  async updateSession(sessionKey, updater) {
    const state = await this.readAll();
    const next = await updater({ ...(state[sessionKey] || {}) });
    if (next == null) {
      delete state[sessionKey];
    } else {
      state[sessionKey] = next;
    }
    await this.writeAll(state);
    return state[sessionKey];
  }

  async deleteSession(sessionKey) {
    const state = await this.readAll();
    delete state[sessionKey];
    await this.writeAll(state);
  }
}

export class FileTurnStateStore extends InMemoryTurnStateStore {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.logger = options.logger;
  }

  async readAll() {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      this.logger?.warn?.(`Failed to read adapter state file: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }

  async writeAll(state) {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }
}

function normalizeEvent(event) {
  if (event === "sessionEnd") return "session_end";
  if (event === "session-end") return "session_end";
  return event || "ignore";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export class MemoryAdapterRuntime {
  constructor(options) {
    if (!options?.platform) throw new TypeError("MemoryAdapterRuntime requires a platform adapter");
    this.platform = options.platform;
    this.client = options.client || new TdaiGatewayClient();
    this.stateStore = options.stateStore || new InMemoryTurnStateStore();
    this.logger = options.logger || console;
    this.failOpen = options.failOpen !== false;
  }

  async handle(input) {
    const context = {
      client: this.client,
      stateStore: this.stateStore,
      logger: this.logger,
    };

    try {
      const event = normalizeEvent(await this.platform.event(input, context));
      if (event === "recall") return await this.handleRecall(input, context);
      if (event === "capture") return await this.handleCapture(input, context);
      if (event === "session_end") return await this.handleSessionEnd(input, context);
      return await this.passThrough(input, context);
    } catch (error) {
      if (!this.failOpen) throw error;
      this.logger?.warn?.(`TencentDB Agent Memory adapter failed open: ${error instanceof Error ? error.message : String(error)}`);
      return await this.passThrough(input, context);
    }
  }

  async requireSession(input, context) {
    const session = await this.platform.session(input, context);
    const sessionKey = nonEmptyString(session?.sessionKey ?? session?.session_key);
    if (!sessionKey) return null;
    return {
      sessionKey,
      sessionId: nonEmptyString(session?.sessionId ?? session?.session_id) || sessionKey,
      userId: nonEmptyString(session?.userId ?? session?.user_id),
    };
  }

  async handleRecall(input, context) {
    const session = await this.requireSession(input, context);
    if (!session) return await this.passThrough(input, context);

    const query = nonEmptyString(await this.platform.recallQuery?.(input, { ...context, session }));
    if (!query) return await this.passThrough(input, context);

    await this.platform.beforeRecall?.(input, { ...context, session, query });
    const recall = await this.client.recall({
      query,
      sessionKey: session.sessionKey,
      userId: session.userId,
    });
    await this.platform.afterRecall?.(recall, input, { ...context, session, query });

    const memoryContext = nonEmptyString(recall.context);
    if (!memoryContext) return await this.passThrough(input, context);
    return await this.platform.injectRecall(memoryContext, input, { ...context, session, query, recall });
  }

  async handleCapture(input, context) {
    const session = await this.requireSession(input, context);
    if (!session) return await this.passThrough(input, context);

    const turn = await this.platform.completedTurn?.(input, { ...context, session });
    const userText = nonEmptyString(turn?.userText ?? turn?.user_content);
    const assistantText = nonEmptyString(turn?.assistantText ?? turn?.assistant_content);
    if (!userText || !assistantText) return await this.passThrough(input, context);

    const capture = await this.client.capture({
      userText,
      assistantText,
      sessionKey: session.sessionKey,
      sessionId: nonEmptyString(turn?.sessionId ?? turn?.session_id) || session.sessionId,
      userId: nonEmptyString(turn?.userId ?? turn?.user_id) || session.userId,
      messages: turn?.messages,
    });
    await this.platform.afterCapture?.(capture, input, {
      ...context,
      session,
      turn: { ...turn, userText, assistantText },
    });
    return await this.passThrough(input, context);
  }

  async handleSessionEnd(input, context) {
    const session = await this.requireSession(input, context);
    if (!session) return await this.passThrough(input, context);
    const result = await this.client.endSession({
      sessionKey: session.sessionKey,
      userId: session.userId,
    });
    await this.platform.afterSessionEnd?.(result, input, { ...context, session });
    return await this.passThrough(input, context);
  }

  async passThrough(input, context) {
    return await this.platform.passThrough?.(input, context);
  }
}
