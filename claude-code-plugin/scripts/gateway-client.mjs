import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8420";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 1_000_000;

export class GatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = options.status;
    this.code = options.code;
    this.cause = options.cause;
  }
}

export class GatewayClient {
  constructor(options = {}) {
    this.baseUrl = normalizeGatewayUrl(
      options.baseUrl ?? process.env.TDAI_GATEWAY_URL ?? DEFAULT_GATEWAY_URL
    );
    this.apiKey = options.apiKey ?? process.env.TDAI_GATEWAY_API_KEY ?? "";
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? process.env.TDAI_GATEWAY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      1_000,
      300_000
    );
  }

  health(options = {}) {
    return this.#request("GET", "health", undefined, options.timeoutMs);
  }

  recall(input, options = {}) {
    return this.#request("POST", "recall", input, options.timeoutMs);
  }

  capture(input, options = {}) {
    return this.#request("POST", "capture", input, options.timeoutMs);
  }

  searchMemories(input, options = {}) {
    return this.#request("POST", "search/memories", input, options.timeoutMs);
  }

  searchConversations(input, options = {}) {
    return this.#request("POST", "search/conversations", input, options.timeoutMs);
  }

  endSession(input, options = {}) {
    return this.#request("POST", "session/end", input, options.timeoutMs);
  }

  async #request(method, route, body, timeoutOverride) {
    const timeoutMs = positiveInteger(timeoutOverride, this.timeoutMs, 1_000, 300_000);
    const headers = {
      accept: "application/json"
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    let response;
    try {
      response = await fetch(new URL(route, this.baseUrl), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new GatewayError(`Gateway request timed out after ${timeoutMs}ms`, {
          code: "TIMEOUT",
          cause: error
        });
      }
      throw new GatewayError("Could not reach the TencentDB Agent Memory Gateway", {
        code: "UNREACHABLE",
        cause: error
      });
    }

    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new GatewayError("Gateway response exceeded the adapter safety limit", {
        status: response.status,
        code: "RESPONSE_TOO_LARGE"
      });
    }

    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new GatewayError("Gateway returned a non-JSON response", {
          status: response.status,
          code: "INVALID_RESPONSE",
          cause: error
        });
      }
    }

    if (!response.ok) {
      const message =
        typeof payload?.error === "string"
          ? payload.error.slice(0, 300)
          : `Gateway request failed with HTTP ${response.status}`;
      throw new GatewayError(message, {
        status: response.status,
        code: typeof payload?.code === "string" ? payload.code : "HTTP_ERROR"
      });
    }

    return payload;
  }
}

export function makeSessionKey(sessionId, cwd) {
  const prefix = sanitizePrefix(process.env.TDAI_CLAUDE_SESSION_PREFIX ?? "claude-code");
  const projectSource =
    process.env.TDAI_CLAUDE_PROJECT_DIR || cwd || process.cwd();
  const normalizedProject = path.resolve(projectSource);
  const projectHash = digest(normalizedProject).slice(0, 16);
  const sessionHash = digest(String(sessionId)).slice(0, 24);
  return `${prefix}:${projectHash}:${sessionHash}`;
}

export function optionalUserId() {
  const value = process.env.TDAI_USER_ID?.trim();
  return value ? value.slice(0, 256) : undefined;
}

export function envEnabled(name, defaultValue = true) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function boundedInteger(value, fallback, minimum, maximum) {
  return positiveInteger(value, fallback, minimum, maximum);
}

export function boundedText(value, maximumChars) {
  if (typeof value !== "string") return "";
  return value.length <= maximumChars ? value : value.slice(0, maximumChars);
}

function normalizeGatewayUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new GatewayError("TDAI_GATEWAY_URL must be a valid HTTP(S) URL", {
      code: "INVALID_URL"
    });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new GatewayError("TDAI_GATEWAY_URL must use HTTP or HTTPS", {
      code: "INVALID_URL"
    });
  }
  if (url.username || url.password) {
    throw new GatewayError("Put Gateway credentials in TDAI_GATEWAY_API_KEY, not in the URL", {
      code: "INVALID_URL"
    });
  }
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function positiveInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function sanitizePrefix(value) {
  const safe = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safe || "claude-code";
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
