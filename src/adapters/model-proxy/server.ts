import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  getLastUserText,
  injectRecallContext,
  parseChatCompletionRequest,
  selectRecallContext,
} from "./chat-protocol.js";
import { CaptureOutbox } from "./capture-outbox.js";
import {
  CompletionAccumulator,
  SseDataParser,
} from "./completion-accumulator.js";
import { HttpModelProxyGateway } from "./gateway-client.js";
import { SessionLineage } from "./session-lineage.js";
import type {
  ChatCompletionRequest,
  ChatMessage,
  ModelProxyGateway,
  ModelProxyLogger,
  SessionResolution,
} from "./types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const INTERNAL_HEADERS = new Set([
  "x-tdai-client-id",
  "x-tdai-session-key",
  "x-tdai-skip-memory",
  "x-tdai-user-id",
]);

const DEFAULT_LOGGER: ModelProxyLogger = {
  debug: (message) => console.debug(message),
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export interface ModelMemoryProxyOptions {
  upstreamBaseUrl: string;
  gateway?: ModelProxyGateway;
  gatewayBaseUrl?: string;
  gatewayApiKey?: string;
  gatewayRecallTimeoutMs?: number;
  gatewayWriteTimeoutMs?: number;
  sessionSecret?: string;
  sessionIdleMs?: number;
  maxMemoryChars?: number;
  maxRequestBytes?: number;
  outboxPath?: string;
  fetchImpl?: typeof fetch;
  logger?: ModelProxyLogger;
}

interface CachedRecall {
  context: string;
  expiresAt: number;
}

class ClientRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClientRequestError";
  }
}

export class ModelMemoryProxy {
  private readonly upstreamBaseUrl: URL;
  private readonly gateway: ModelProxyGateway;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ModelProxyLogger;
  private readonly lineage: SessionLineage;
  private readonly outbox: CaptureOutbox;
  private readonly sessionIdleMs: number;
  private readonly maxMemoryChars: number;
  private readonly maxRequestBytes: number;
  private readonly recallCache = new Map<string, CachedRecall>();
  private readonly sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeSessions = new Map<string, string | undefined>();
  private server?: http.Server;
  private closed = false;

  constructor(options: ModelMemoryProxyOptions) {
    this.upstreamBaseUrl = normalizeUpstreamBaseUrl(options.upstreamBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.gateway = options.gateway ?? new HttpModelProxyGateway({
      baseUrl: options.gatewayBaseUrl ?? "http://127.0.0.1:8420",
      apiKey: options.gatewayApiKey,
      recallTimeoutMs: options.gatewayRecallTimeoutMs,
      writeTimeoutMs: options.gatewayWriteTimeoutMs,
      fetchImpl: options.fetchImpl,
    });
    this.lineage = new SessionLineage({
      secret: options.sessionSecret ?? randomBytes(32).toString("hex"),
    });
    this.sessionIdleMs = options.sessionIdleMs ?? 30 * 60_000;
    this.maxMemoryChars = options.maxMemoryChars ?? 12_000;
    this.maxRequestBytes = options.maxRequestBytes ?? 10 * 1024 * 1024;
    this.outbox = new CaptureOutbox({
      databasePath: options.outboxPath ?? ":memory:",
      gateway: this.gateway,
      logger: this.logger,
    });
  }

  async listen(options?: { host?: string; port?: number }): Promise<AddressInfo> {
    if (this.closed) throw new Error("Model memory proxy is closed");
    if (this.server) throw new Error("Model memory proxy is already listening");
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    const host = options?.host ?? "127.0.0.1";
    const port = options?.port ?? 8421;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Model memory proxy did not expose a TCP address");
    }
    return address;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => error ? reject(error) : resolve());
      });
      this.server = undefined;
    }
    for (const timer of this.sessionTimers.values()) clearTimeout(timer);
    this.sessionTimers.clear();
    await this.outbox.flush();
    if (this.outbox.pendingCount() === 0) {
      await Promise.allSettled(
        [...this.activeSessions].map(([sessionKey, userId]) =>
          this.gateway.endSession({ session_key: sessionKey, user_id: userId })
        ),
      );
    } else {
      this.logger.warn(
        `[model-proxy] Skipping session flush during shutdown because ` +
        `${this.outbox.pendingCount()} capture(s) remain queued`,
      );
    }
    this.activeSessions.clear();
    await this.outbox.close();
  }

  /** Test/operations hook for forcing queued captures through the Gateway. */
  async drainCaptures(): Promise<void> {
    await this.outbox.flush();
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://model-proxy.local");
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        outbox_pending: this.outbox.pendingCount(),
        active_sessions: this.activeSessions.size,
      });
      return;
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/v1/chat/completions") {
      sendJson(response, 404, { error: "Only POST /v1/chat/completions is supported" });
      return;
    }

    try {
      const rawBody = await readRequestBody(request, this.maxRequestBytes);
      let original: ChatCompletionRequest;
      try {
        original = parseChatCompletionRequest(JSON.parse(rawBody.toString("utf8")));
      } catch (error) {
        throw new ClientRequestError(
          400,
          error instanceof Error ? error.message : "Invalid JSON request",
        );
      }
      const skipMemory = singleHeader(request.headers["x-tdai-skip-memory"]) === "1";
      const userText = getLastUserText(original.messages);
      if (!userText) {
        sendJson(response, 400, { error: "A non-empty user message is required" });
        return;
      }

      const namespace = resolveClientNamespace(request);
      const explicitSessionKey = validateSessionHeader(
        singleHeader(request.headers["x-tdai-session-key"]),
      );
      const userId = singleHeader(request.headers["x-tdai-user-id"]);
      const resolution = this.lineage.resolve(original.messages, {
        namespace,
        explicitSessionKey,
      });
      this.touchSession(resolution.sessionKey, userId);

      const context = skipMemory
        ? ""
        : await this.recallFailOpen(userText, resolution, userId);
      const outgoing = injectRecallContext(original, context);
      const upstreamResponse = await this.forward(request, requestUrl, outgoing);
      await this.pipeAndObserve(
        upstreamResponse,
        response,
        original,
        resolution,
        userText,
        userId,
        skipMemory,
      );
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error instanceof ClientRequestError ? error.status : 502, {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async recallFailOpen(
    query: string,
    resolution: SessionResolution,
    userId?: string,
  ): Promise<string> {
    const cacheKey = `${resolution.sessionKey}\0${resolution.turnKey}`;
    const cached = this.recallCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.context;

    try {
      const result = await this.gateway.recall({
        query,
        session_key: resolution.sessionKey,
        user_id: userId,
      });
      const context = selectRecallContext(result, this.maxMemoryChars);
      this.recallCache.set(cacheKey, {
        context,
        expiresAt: Date.now() + 10 * 60_000,
      });
      this.pruneRecallCache();
      return context;
    } catch (error) {
      this.logger.warn(
        `[model-proxy] Recall failed open for ${resolution.sessionKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "";
    }
  }

  private forward(
    request: http.IncomingMessage,
    requestUrl: URL,
    body: ChatCompletionRequest,
  ): Promise<Response> {
    const upstreamUrl = new URL(this.upstreamBaseUrl);
    const prefix = upstreamUrl.pathname.replace(/\/$/, "");
    upstreamUrl.pathname = `${prefix}${requestUrl.pathname}`;
    upstreamUrl.search = requestUrl.search;

    return this.fetchImpl(upstreamUrl, {
      method: "POST",
      headers: forwardRequestHeaders(request.headers),
      body: JSON.stringify(body),
      redirect: "manual",
    });
  }

  private async pipeAndObserve(
    upstream: Response,
    downstream: http.ServerResponse,
    original: ChatCompletionRequest,
    resolution: SessionResolution,
    userText: string,
    userId: string | undefined,
    skipMemory: boolean,
  ): Promise<void> {
    downstream.writeHead(upstream.status, forwardResponseHeaders(upstream.headers));
    if (!upstream.body) {
      downstream.end();
      return;
    }

    const accumulator = new CompletionAccumulator();
    if (original.stream) {
      const parser = new SseDataParser((data) => accumulator.acceptStreamData(data));
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (downstream.destroyed) {
          await reader.cancel();
          return;
        }
        parser.push(value);
        if (!downstream.write(Buffer.from(value))) {
          await Promise.race([
            once(downstream, "drain"),
            once(downstream, "close"),
          ]);
          if (downstream.destroyed) {
            await reader.cancel();
            return;
          }
        }
      }
      parser.finish();
      downstream.end();
    } else {
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      downstream.end(Buffer.from(bytes));
      try {
        accumulator.acceptResponseBody(JSON.parse(Buffer.from(bytes).toString("utf8")));
      } catch {
        // Non-JSON upstream errors are forwarded byte-for-byte and not captured.
      }
    }

    if (!upstream.ok) return;
    const assistantMessage = accumulator.assistantMessage();
    this.lineage.commitAssistant(resolution, assistantMessage);
    if (!skipMemory && accumulator.shouldCapture()) {
      this.enqueueCapture(
        original,
        resolution,
        userText,
        accumulator.assistantText(),
        assistantMessage,
        userId,
      );
    }
  }

  private enqueueCapture(
    original: ChatCompletionRequest,
    resolution: SessionResolution,
    userText: string,
    assistantText: string,
    assistantMessage: ChatMessage,
    userId?: string,
  ): void {
    const id = createHash("sha256")
      .update(resolution.sessionKey)
      .update("\0")
      .update(resolution.turnKey)
      .update("\0")
      .update(assistantText)
      .digest("hex");
    this.outbox.enqueue(id, {
      user_content: userText,
      assistant_content: assistantText,
      messages: [...original.messages, assistantMessage],
      session_key: resolution.sessionKey,
      user_id: userId,
      idempotency_key: id,
    });
  }

  private touchSession(sessionKey: string, userId?: string): void {
    const previous = this.sessionTimers.get(sessionKey);
    if (previous) clearTimeout(previous);
    this.activeSessions.set(sessionKey, userId);
    const timer = setTimeout(() => {
      void this.flushIdleSession(sessionKey, userId);
    }, this.sessionIdleMs);
    timer.unref();
    this.sessionTimers.set(sessionKey, timer);
  }

  private async flushIdleSession(
    sessionKey: string,
    userId?: string,
  ): Promise<void> {
    this.sessionTimers.delete(sessionKey);
    await this.outbox.flush();
    if (this.outbox.pendingCount() > 0) {
      this.logger.warn(
        `[model-proxy] Delaying idle session flush for ${sessionKey}; ` +
        `${this.outbox.pendingCount()} capture(s) remain queued`,
      );
      this.touchSession(sessionKey, userId);
      return;
    }
    this.activeSessions.delete(sessionKey);
    try {
      await this.gateway.endSession({ session_key: sessionKey, user_id: userId });
    } catch (error) {
      this.logger.warn(
        `[model-proxy] Idle session flush failed for ${sessionKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.touchSession(sessionKey, userId);
    }
  }

  private pruneRecallCache(): void {
    if (this.recallCache.size <= 2_000) return;
    const now = Date.now();
    for (const [key, entry] of this.recallCache) {
      if (entry.expiresAt <= now || this.recallCache.size > 2_000) {
        this.recallCache.delete(key);
      }
    }
  }
}

function normalizeUpstreamBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Upstream model URL must use http: or https:");
  }
  if (url.username || url.password) {
    throw new Error("Upstream model URL must not contain embedded credentials");
  }
  url.search = "";
  url.hash = "";
  return url;
}

function resolveClientNamespace(request: http.IncomingMessage): string {
  const explicit = singleHeader(request.headers["x-tdai-client-id"]);
  if (explicit) {
    return createHash("sha256").update(explicit).digest("hex");
  }
  const credential = singleHeader(request.headers.authorization) ?? "";
  const remote = request.socket.remoteAddress ?? "unknown";
  return createHash("sha256")
    .update(credential)
    .update("\0")
    .update(remote)
    .digest("hex");
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validateSessionHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > 256 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ClientRequestError(
      400,
      "X-TDAI-Session-Key must be 1-256 bytes without control characters",
    );
  }
  return trimmed;
}

function forwardRequestHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const result: Record<string, string> = {
    "content-type": "application/json",
    "accept-encoding": "identity",
  };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      INTERNAL_HEADERS.has(lower) ||
      lower === "accept-encoding" ||
      value === undefined
    ) {
      continue;
    }
    result[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function forwardResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower) && lower !== "content-encoding") {
      result[name] = value;
    }
  });
  return result;
}

async function readRequestBody(
  request: http.IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new ClientRequestError(413, `Request body exceeds ${limit} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
