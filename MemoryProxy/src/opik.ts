/** Opik tracing client for context-proxy.
 *
 * Project name is derived from the request API key:
 *   SHA-256(apiKey) → hex → first 8 chars
 *
 * All network calls are fire-and-forget. Failures are logged via structured logger
 * and never propagate to the hot request path.
 */

import { createHash, randomBytes } from "node:crypto";
import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";

const OPIK_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Generate a UUID v7 (time-ordered), required by Opik API.
 * Layout: 48-bit unix_ts_ms | 4-bit ver(0x7) | 12-bit rand_a | 2-bit var(0b10) | 62-bit rand_b
 */
function uuidv7(): string {
  const now = BigInt(Date.now());
  const rand = randomBytes(10); // 80 bits of randomness

  // rand_a: 12 bits from rand[0..1]
  const randA = ((rand[0] << 4) | (rand[1] >> 4)) & 0xfff;
  // rand_b: 62 bits — first byte forced to variant 0b10xx_xxxx
  const b8 = (rand[2] & 0x3f) | 0x80;

  const p1 = (now >> 16n).toString(16).padStart(8, "0");
  const p2 = (now & 0xffffn).toString(16).padStart(4, "0");
  const p3 = (0x7000 | randA).toString(16).padStart(4, "0");
  const p4 = b8.toString(16).padStart(2, "0") + rand[3].toString(16).padStart(2, "0");
  const p5 = Array.from(rand.slice(4)).map((b) => b.toString(16).padStart(2, "0")).join("");

  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}

/** Derive an 8-char key ID from an API key (SHA-256 first 8 hex chars). */
export function apiKeyToKeyId(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
}

/** Extract the bearer token from an Authorization header value.
 *  Returns empty string when the header is absent or not a Bearer token.
 */
export function extractBearerToken(authHeader: string | null | undefined): string {
  if (!authHeader) return "";
  const match = authHeader.match(/^[Bb]earer\s+(.+)$/);
  return match ? match[1].trim() : "";
}

interface OpikTraceInput {
  traceId: string;
  projectName: string;
  name: string;
  startTime: string; // ISO 8601
  input: Record<string, unknown>;
  tags?: string[];
  /** Fork to a second project (e.g. "request_log"). Uses a separate trace ID. */
  forkProjectName?: string;
  /** Metadata attached to forked trace. */
  forkMetadata?: Record<string, unknown>;
}

interface OpikTraceUpdate {
  traceId: string;
  projectName: string;
  endTime: string;
  output: Record<string, unknown> | unknown[];
  usage: Record<string, unknown>; // raw, unmodified
}

interface OpikLlmSpan {
  traceId: string;
  projectName: string;
  name: string;
  startTime: string;
  endTime: string;
  inputMessages: unknown[];   // full messages array sent to LLM
  outputMessage: Record<string, unknown> | null;
  model: string;
  usage: Record<string, unknown>;
  tags?: string[];            // optional tags for categorisation
  /** Fork to a second project (e.g. "request_log"). Requires forkTraceId. */
  forkProjectName?: string;
  /** Independent trace ID for the forked span (different from main traceId). */
  forkTraceId?: string;
  /** Metadata attached to forked span. */
  forkMetadata?: Record<string, unknown>;
}

/**
 * Fire a single POST to create a trace (internal helper, no early-return guard).
 */
function fireCreateTrace(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): void {
  fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OPIK_REQUEST_TIMEOUT_MS),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn("opik.create_trace_error", { status: res.status, body: body.slice(0, 200) });
    }
  }).catch((err: unknown) => {
    log.warn("opik.create_trace_failed", { error: String(err) });
  });
}

/** POST a new trace to Opik (fire-and-forget).
 *  Returns the forkTraceId if forkProjectName was set (different ID than main trace),
 *  or empty string otherwise. The main trace is always created with input.traceId. */
export function opikCreateTrace(
  config: ProxyConfig,
  input: OpikTraceInput,
): string {
  if (!config.opik.enabled || !config.opik.url) return "";

  const baseUrl = config.opik.url.replace(/\/$/, "");
  const url = `${baseUrl}/api/v1/private/traces`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.opik.apiKey) headers["Authorization"] = `Bearer ${config.opik.apiKey}`;

  const traceBody: Record<string, unknown> = {
    id: input.traceId,
    project_name: input.projectName,
    name: input.name,
    start_time: input.startTime,
    input: input.input,
  };
  if (input.tags && input.tags.length > 0) {
    traceBody.tags = input.tags;
  }

  fireCreateTrace(url, headers, traceBody);

  // Fork to a second project if requested — uses a DIFFERENT trace ID because
  // Opik rejects the same trace_id across different projects (409 conflict).
  if (input.forkProjectName) {
    const forkTraceId = uuidv7();
    const forkMeta = input.forkMetadata || {};
    const forkBody: Record<string, unknown> = {
      ...traceBody,
      id: forkTraceId,
      project_name: input.forkProjectName,
      input: config.opik.stripRequestLogContent ? { messages: "[stripped]" } : input.input,
      // tags: only keyId and modelId, strip routing / stream / anthropic etc.
      tags: [
        `keyId:${forkMeta.keyId || "unknown"}`,
        `modelId:${forkMeta.modelId || "unknown"}`,
      ],
    };
    if (input.forkMetadata) {
      forkBody.metadata = { ...input.forkMetadata, forkTraceId };
    } else {
      forkBody.metadata = { forkTraceId };
    }
    fireCreateTrace(url, headers, forkBody);
    return forkTraceId;
  }
  return "";
}

/** PATCH/update an existing trace with output + usage (fire-and-forget). */
export function opikUpdateTrace(
  config: ProxyConfig,
  update: OpikTraceUpdate,
): void {
  if (!config.opik.enabled || !config.opik.url) return;

  const url = `${config.opik.url.replace(/\/$/, "")}/api/v1/private/traces/${update.traceId}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.opik.apiKey) headers["Authorization"] = `Bearer ${config.opik.apiKey}`;

  fetch(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      project_name: update.projectName,
      workspace_name: "default",
      end_time: update.endTime,
      output: update.output,
      usage: update.usage, // raw, unmodified
    }),
    signal: AbortSignal.timeout(OPIK_REQUEST_TIMEOUT_MS),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn("opik.update_trace_error", { status: res.status, body: body.slice(0, 200) });
    }
  }).catch((err: unknown) => {
    log.warn("opik.update_trace_failed", { error: String(err) });
  });
}

/**
 * Fire a single POST to create an LLM span (internal helper, no early-return guard).
 */
function fireCreateLlmSpan(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): void {
  fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OPIK_REQUEST_TIMEOUT_MS),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn("opik.create_llm_span_error", { status: res.status, body: body.slice(0, 200) });
    }
  }).catch((err: unknown) => {
    log.warn("opik.create_llm_span_failed", { error: String(err) });
  });
}

/** POST a LLM span under an existing trace (fire-and-forget).
 *  This is what populates the "Messages" panel in Opik UI. */
export function opikCreateLlmSpan(
  config: ProxyConfig,
  span: OpikLlmSpan,
): void {
  if (!config.opik.enabled || !config.opik.url) return;

  const baseUrl = config.opik.url.replace(/\/$/, "");
  const url = `${baseUrl}/api/v1/private/spans`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.opik.apiKey) headers["Authorization"] = `Bearer ${config.opik.apiKey}`;

  const outputMessages = span.outputMessage ? [span.outputMessage] : [];

  // Opik span usage only accepts flat INTEGER fields — decimals are truncated.
  // Credit values (e.g. 0.43) must be scaled ×100 to preserve precision.
  const flatUsage: Record<string, number> = {};
  for (const [k, v] of Object.entries(span.usage)) {
    if (typeof v === "number") {
      if (k === "credit") {
        // Store as credit_x100 (integer) to avoid Opik truncation
        flatUsage["credit_x100"] = Math.round(v * 100);
      } else {
        flatUsage[k] = v;
      }
    }
  }

  const body: Record<string, unknown> = {
    id: uuidv7(),
    trace_id: span.traceId,
    project_name: span.projectName,
    name: span.name,
    type: "llm",
    start_time: span.startTime,
    end_time: span.endTime,
    input: span.inputMessages,    // 直接传 messages 数组
    output: outputMessages,       // 直接传 messages 数组
    model: span.model,
    usage: flatUsage,
  };
  if (span.tags && span.tags.length > 0) {
    body.tags = span.tags;
  }

  fireCreateLlmSpan(url, headers, body);

  // Fork to a second project if requested — strip message content, keep only usage + metadata.
  // Uses forkTraceId (different from main traceId) because Opik rejects cross-project trace reuse.
  if (span.forkProjectName && span.forkTraceId) {
    const forkMeta = span.forkMetadata || {};
    const forkMetadataFull: Record<string, unknown> = { ...forkMeta };
    // Preserve raw credit in metadata for reference (usage only stores credit_x100 integer)
    const rawCredit = span.usage.credit;
    if (typeof rawCredit === "number") {
      forkMetadataFull["credit"] = rawCredit;
    }

    const forkBody: Record<string, unknown> = {
      id: uuidv7(),
      trace_id: span.forkTraceId,     // independent trace ID for fork project
      project_name: span.forkProjectName,
      name: span.name,
      type: "llm",
      start_time: span.startTime,     // use span fields directly (not body which has snake_case keys)
      end_time: span.endTime,
      model: span.model,
      usage: flatUsage,
      metadata: forkMetadataFull,
    };
    if (!config.opik.stripRequestLogContent) {
      forkBody.input = span.inputMessages;
      forkBody.output = outputMessages;
    }
    // request_log tags: only keyId and modelId, nothing else
    forkBody.tags = [
      `keyId:${forkMeta.keyId || "unknown"}`,
      `modelId:${forkMeta.modelId || "unknown"}`,
    ];
    fireCreateLlmSpan(url, headers, forkBody);
  }
}

export { uuidv7 };
