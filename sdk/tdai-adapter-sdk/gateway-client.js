/**
 * TdaiGatewayClient — a zero-dependency HTTP client for the TdaiGateway.
 *
 * Wraps all 7 Gateway endpoints with a single, reusable, testable surface:
 *   health, recall, capture, searchMemories, searchConversations,
 *   endSession, seed
 *
 * Design goals:
 *   - Zero external dependencies (only `node:http` / `node:https`).
 *   - Optional Bearer auth: when `apiKey` is set, every request attaches
 *     `Authorization: Bearer <key>` (fills the gap left by the raw Whale/Codex
 *     hooks, and matches the Gateway's constant-time checkAuth).
 *   - Uniform timeout + error wrapping + structured (silent-by-default) logging.
 *
 * Request/response bodies use the Gateway's snake_case wire format
 * (see src/gateway/types.ts).
 */

import http from "node:http";
import https from "node:https";

import { resolveConfig } from "./config.js";
import { silentLogger } from "./logger.js";

export class TdaiGatewayError extends Error {
  /**
   * @param {string} message
   * @param {Object} [opts]
   * @param {number} [opts.status] HTTP status code (if a response was received).
   * @param {string} [opts.path] Request path.
   * @param {unknown} [opts.cause] Underlying error.
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "TdaiGatewayError";
    this.status = opts.status;
    this.path = opts.path;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export class TdaiGatewayClient {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseUrl] Gateway base URL (default env TDAI_GATEWAY_URL or 127.0.0.1:8420).
   * @param {string} [opts.apiKey] Optional Bearer token (default env TDAI_GATEWAY_API_KEY).
   * @param {number} [opts.timeoutMs] Default per-request timeout (default env or 12000).
   * @param {import("./logger.js").Logger} [opts.logger]
   */
  constructor(opts = {}) {
    const cfg = resolveConfig(opts);
    this.baseUrl = cfg.baseUrl;
    this.apiKey = cfg.apiKey;
    this.timeoutMs = cfg.timeoutMs;
    this.logger = opts.logger ?? silentLogger;
  }

  /** GET /health */
  async health(timeoutMs) {
    return this._request("GET", "/health", undefined, timeoutMs);
  }

  /**
   * POST /recall
   * @param {{ query: string, sessionKey?: string, userId?: string }} params
   */
  async recall(params) {
    const body = { query: params.query, session_key: params.sessionKey ?? "" };
    if (params.userId) body.user_id = params.userId;
    return this._request("POST", "/recall", body);
  }

  /**
   * POST /capture
   * @param {{ userContent: string, assistantContent: string, sessionKey?: string, sessionId?: string, userId?: string, messages?: unknown[] }} params
   */
  async capture(params) {
    const body = {
      user_content: params.userContent,
      assistant_content: params.assistantContent,
      session_key: params.sessionKey ?? "",
    };
    if (params.sessionId) body.session_id = params.sessionId;
    if (params.userId) body.user_id = params.userId;
    if (params.messages) body.messages = params.messages;
    return this._request("POST", "/capture", body);
  }

  /**
   * POST /search/memories
   * @param {{ query: string, limit?: number, type?: string, scene?: string }} params
   */
  async searchMemories(params) {
    const body = { query: params.query };
    if (params.limit != null) body.limit = params.limit;
    if (params.type) body.type = params.type;
    if (params.scene) body.scene = params.scene;
    return this._request("POST", "/search/memories", body);
  }

  /**
   * POST /search/conversations
   * @param {{ query: string, limit?: number, sessionKey?: string }} params
   */
  async searchConversations(params) {
    const body = { query: params.query };
    if (params.limit != null) body.limit = params.limit;
    if (params.sessionKey) body.session_key = params.sessionKey;
    return this._request("POST", "/search/conversations", body);
  }

  /**
   * POST /session/end
   * @param {{ sessionKey: string, userId?: string }} params
   */
  async endSession(params) {
    const body = { session_key: params.sessionKey ?? "" };
    if (params.userId) body.user_id = params.userId;
    return this._request("POST", "/session/end", body);
  }

  /**
   * POST /seed
   * @param {{ data: unknown, sessionKey?: string, strictRoundRole?: boolean, autoFillTimestamps?: boolean, configOverride?: Record<string, unknown> }} params
   * @param {number} [timeoutMs] Seed can be slow — override the default timeout.
   */
  async seed(params, timeoutMs = 300000) {
    const body = { data: params.data };
    if (params.sessionKey) body.session_key = params.sessionKey;
    if (params.strictRoundRole) body.strict_round_role = true;
    if (params.autoFillTimestamps === false) body.auto_fill_timestamps = false;
    if (params.configOverride) body.config_override = params.configOverride;
    return this._request("POST", "/seed", body, timeoutMs);
  }

  // -- internals ------------------------------------------------------------

  /**
   * @param {"GET"|"POST"} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  _request(method, path, body, timeoutMs) {
    const url = new URL(path, this.baseUrl);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const timeout = timeoutMs ?? this.timeoutMs;

    const headers = {};
    let payload;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), "utf-8");
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    this.logger.debug?.(`${method} ${url.pathname} (timeout=${timeout}ms)`);

    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              this.logger.warn?.(`${method} ${url.pathname} → ${status}: ${text.slice(0, 200)}`);
              reject(
                new TdaiGatewayError(`Gateway ${path} returned ${status}`, {
                  status,
                  path,
                }),
              );
              return;
            }
            try {
              resolve(text ? JSON.parse(text) : {});
            } catch (e) {
              reject(new TdaiGatewayError(`Gateway ${path} returned invalid JSON`, { path, cause: e }));
            }
          });
        },
      );

      req.on("error", (e) => {
        this.logger.debug?.(`${method} ${url.pathname} failed: ${e.message}`);
        reject(new TdaiGatewayError(`Gateway ${path} request failed: ${e.message}`, { path, cause: e }));
      });

      // Guard against a hung Gateway — abort the socket on timeout.
      req.setTimeout(timeout, () => {
        req.destroy(new TdaiGatewayError(`Gateway ${path} timed out after ${timeout}ms`, { path }));
      });

      if (payload) req.write(payload);
      req.end();
    });
  }
}
