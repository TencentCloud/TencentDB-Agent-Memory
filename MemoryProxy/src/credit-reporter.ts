// Credit usage reporting to external service (e.g. TDAI MemoryPlus).
// On LLM response, POST {SpaceId, MemoryLevel, MemoryDelta, CreditDelta} to
// configured URL. SpaceId is extracted from request path /proxy/<spaceId>/...,
// MemoryLevel is fixed "proxy", MemoryDelta is 0, CreditDelta = computed credit.

import type { CreditPricingConfig, CreditReportConfig } from "./types.js";
import { getModelPricing } from "./pricing.js";
import { log } from "./report/log.js";

export interface CreditReportRequest {
  SpaceId: string;
  MemoryLevel: string;
  MemoryDelta: number;
  CreditDelta: number;
}

export interface CreditReportResult {
  ok: boolean;
  status?: number;
  /** Service-level response (echoed back, even on logical error). */
  response?: unknown;
  /** Transport/timeout error message. */
  error?: string;
}

/** Fixed MemoryLevel value used by this proxy when reporting credit. */
export const PROXY_MEMORY_LEVEL = "proxy";

/** Maximum length of the value placed into the `x-credit-report-error` header. */
const MAX_ERROR_HEADER_LEN = 256;

/**
 * Detect usage schema protocol from upstream URL path.
 *
 * - `/v1/messages` (含子路径 `/v1/messages/count_tokens`、`/v1/messages?...`) → "anthropic"
 * - 其它路径（包括 `/v1/chat/completions` 与未识别路径） → "openai"
 *
 * 选 openai 作为兜底默认的理由：Anthropic 分支假设 input_tokens 已扣缓存，
 * 若被错误应用到 OpenAI usage 上会把 cache 部分按 input 高价重复计费；
 * 反之 OpenAI 分支「先减后算」，即使误用到 Anthropic usage 也仅退化为等价旧逻辑，
 * 风险不对称，故取 openai 兜底。
 *
 * 大小写不敏感。
 */
export function detectUsageProtocol(upstreamUrl: string): "anthropic" | "openai" {
  const path = upstreamUrl.toLowerCase();
  // /v1/messages 后必须是 / 或 ? 或字符串结尾，避免误匹配 /v1/messages_admin
  if (/\/v1\/messages(\/|\?|$)/.test(path)) return "anthropic";
  return "openai";
}

/**
 * Extract SpaceId from a request path like `/proxy/<spaceId>/v1/messages`.
 *
 * Behaviour:
 * - Allows optional leading slash.
 * - Strips any `?query` suffix defensively (Hono's `c.req.path` normally has
 *   no query, but path can be provided by other code paths too).
 * - Rejects empty spaceId (`/proxy//...`), case mismatches (`/PROXY/...`),
 *   and similar-but-distinct prefixes (`/proxyfake/...`).
 *
 * @returns The spaceId string, or `null` when the path does not match the
 *   expected prefix. Callers should treat `null` as "do not report credit
 *   for this request".
 */
export function extractSpaceIdFromPath(path: string): string | null {
  // Defensive: drop query string if accidentally passed in.
  const safePath = path.split("?", 1)[0] ?? "";
  // /proxy/<spaceId>/...
  let match = /^\/?proxy\/([^/?]+)(?:\/|$)/.exec(safePath);
  if (match) return match[1] || null;
  // /<agent>/<spaceId>/...  (e.g. /claude-code/mem-example001/v1/messages)
  match = /^\/[^/]+\/([^/?]+)(?:\/|$)/.exec(safePath);
  if (match) {
    const agent = safePath.split("/").filter(Boolean)[0] ?? "";
    // Only capture spaceId when the first segment looks like an agent name
    if (/^(claude-code|codebuddy|codex|cursor|hermes|openclaw|workbuddy|dsh|opencode|pi)$/i.test(agent)) {
      return match[1] || null;
    }
  }
  return null;
}

/** Compute CreditDelta from an LLM usage object using model-specific pricing.
 *
 * Only applies pricing-based calculation when upstreamUrl contains "tokenhub".
 * For non-TokenHub upstreams (e.g. copilot), returns 0.
 *
 * 通过 `detectUsageProtocol(upstreamUrl)` 判断走 Anthropic 或 OpenAI 分支：
 *
 * Anthropic 分支（`/v1/messages`）：
 *   - nonCacheInput = usage.input_tokens（TokenHub 已扣除 cache 部分）
 *   - cacheRead = usage.cache_read_input_tokens
 *   - cacheWrite5m = usage.cache_creation.ephemeral_5m_input_tokens
 *   - cacheWrite1h = usage.cache_creation_input_tokens - ephemeral_5m_input_tokens
 *
 * OpenAI 分支（`/v1/chat/completions` 或其它路径）：
 *   - nonCacheInput = max(0, usage.prompt_tokens - cached_tokens)（prompt_tokens 含缓存）
 *   - cacheRead = usage.cache_read_tokens ?? usage.prompt_tokens_details.cached_tokens
 *   - cacheWrite5m = 0（OpenAI 无 cache write 概念）
 *   - cacheWrite1h = 0
 *
 * Credit formula (per 1K tokens):
 *   credit = (nonCacheInput / 1000) * pricing.input
 *          + (output / 1000) * pricing.output
 *          + (cacheRead / 1000) * pricing.cacheRead
 *          + (cacheWrite5m / 1000) * pricing.cacheWrite5m
 *          + (cacheWrite1h / 1000) * pricing.cacheWrite1h
 *
 * If upstream is not TokenHub, returns 0.
 * If upstream is TokenHub but model pricing is not found, returns 0
 *   （原始 usage 会由 clickhouse 侧的 `getRawUsageReason → "unknown_model"`
 *   路径落到 raw 表用于追溯，避免把 token 计数当 credit 上报造成计费失真）.
 */
export function computeCreditDelta(
  usage: Record<string, unknown> | null | undefined,
  pricingConfig: CreditPricingConfig | null | undefined,
  modelId?: string,
  upstreamUrl?: string,
): number {
  if (!usage) return 0;

  // Only apply pricing-based calculation for TokenHub upstream
  const isTokenHub = upstreamUrl ? /tokenhub/i.test(upstreamUrl) : false;
  if (!isTokenHub) return 0;

  const protocol = detectUsageProtocol(upstreamUrl ?? "");

  // 通用字段
  const output = numField(usage.completion_tokens) || numField(usage.output_tokens);

  // 按协议分支抽取 5 类 token
  let nonCacheInput = 0;
  let cacheRead = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;

  if (protocol === "anthropic") {
    // Anthropic (TokenHub): input_tokens 已扣缓存
    nonCacheInput = numField(usage.input_tokens);
    cacheRead = numField(usage.cache_read_input_tokens);
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
    const ephemeral5m = numField(cacheCreation?.ephemeral_5m_input_tokens);
    const totalCacheWrite = numField(usage.cache_creation_input_tokens);
    cacheWrite5m = ephemeral5m;
    cacheWrite1h = Math.max(0, totalCacheWrite - ephemeral5m);
  } else {
    // OpenAI: prompt_tokens 含缓存，需减去 cached_tokens
    const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    const promptTokens = numField(usage.prompt_tokens);
    cacheRead =
      numField(usage.cache_read_tokens) ||
      numField(promptDetails?.cached_tokens);
    nonCacheInput = Math.max(0, promptTokens - cacheRead);
    // OpenAI 协议在 TokenHub 现有模型上无 cache write 概念，强制 0，
    // 忽略 usage 中可能出现的 cache_creation_* 字段（避免误计费）。
    cacheWrite5m = 0;
    cacheWrite1h = 0;
  }

  // 查找定价
  const pricing = getModelPricing(pricingConfig, modelId ?? null);

  let credit: number;
  let fallback: string | undefined;

  if (pricing) {
    // 计算 Credit 值
    credit =
      (nonCacheInput / 1000) * pricing.input +
      (output / 1000) * pricing.output +
      (cacheRead / 1000) * pricing.cacheRead +
      (cacheWrite5m / 1000) * pricing.cacheWrite5m +
      (cacheWrite1h / 1000) * pricing.cacheWrite1h;
  } else {
    // 未定价模型：不上报 credit，避免把 token 计数当 credit 计费。
    // 原始 usage 由 clickhouse 侧 `getRawUsageReason → "unknown_model"` 落 raw 表追溯。
    credit = 0;
    fallback = "unknown_model";
  }

  log.debug("credit.compute", {
    protocol,
    model: modelId ?? "unknown",
    rawUsage: usage,
    nonCacheInput,
    output,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    credit,
    ...(fallback ? { fallback } : {}),
  });

  return credit;
}

function numField(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** POST credit usage to the configured endpoint.
 *  Never throws — returns a structured result the caller can react to. */
export async function reportCreditUsage(
  config: CreditReportConfig,
  payload: CreditReportRequest,
): Promise<CreditReportResult> {
  const fetchOpts: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
  if (config.timeoutMs > 0) {
    fetchOpts.signal = AbortSignal.timeout(config.timeoutMs);
  }
  try {
    const resp = await fetch(config.url, fetchOpts);
    const text = await resp.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep as raw text
    }
    if (!resp.ok) {
      return { ok: false, status: resp.status, response: parsed, error: `HTTP ${resp.status}` };
    }
    // The MemoryPlus service returns {code, message, data} — non-zero code = logical failure.
    if (parsed && typeof parsed === "object" && "code" in (parsed as Record<string, unknown>)) {
      const code = (parsed as Record<string, unknown>).code;
      const message = (parsed as Record<string, unknown>).message;
      if (typeof code === "number" && code !== 0) {
        return {
          ok: false,
          status: resp.status,
          response: parsed,
          error: typeof message === "string" ? message : `code=${code}`,
        };
      }
    }
    return { ok: true, status: resp.status, response: parsed };
  } catch (err: unknown) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    return {
      ok: false,
      error: isTimeout
        ? `timeout after ${config.timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/** Outcome of attempting to report credit, suitable for handler decision-making. */
export interface CreditReportOutcome {
  /** True when we actually issued a network request (path had spaceId and usage was non-empty). */
  attempted: boolean;
  /** True only when `attempted` is true and the report succeeded. */
  ok: boolean;
  /** Detailed error suitable for server-side logs (includes spaceId). */
  errorMessage?: string;
  /** Compact, header-safe error string suitable for `x-credit-report-error`. */
  errorHeader?: string;
  /** Raw report result (only present when attempted=true). */
  result?: CreditReportResult;
}

/**
 * Helper: extract spaceId from path, build payload, call reportCreditUsage,
 * and produce a `CreditReportOutcome` that handlers can map to logs + response
 * headers without duplicating the same 8 lines four times.
 *
 * Caller contract:
 * - If `outcome.attempted === false`: do nothing — request did not target the
 *   credit-reporting route or had no usage to report.
 * - If `outcome.attempted === true && outcome.ok === false`: log
 *   `outcome.errorMessage` and set response header
 *   `x-credit-report-error: outcome.errorHeader`.
 * - On success: nothing further needed.
 */
export async function tryReportCreditFromPath(
  config: CreditReportConfig,
  path: string,
  usage: Record<string, unknown> | null | undefined,
  pricingConfig: CreditPricingConfig | null | undefined,
  modelId?: string,
  upstreamUrl?: string,
  /**
   * Log event kind. When `"analyzer_usage"`, this function short-circuits and
   * never issues a credit report — extension telemetry events are
   * infrastructure consumption and must not be billed to the user's memory space.
   * Defaults to `"usage"` semantically when omitted (backward compatible).
   */
  event?: "usage" | "analyzer_usage",
): Promise<CreditReportOutcome> {
  // Defense-in-depth: extension telemetry events must never trigger a credit report.
  // Today the extension telemetry path (writeLog with event="analyzer_usage") does not
  // reach this function, but this guard ensures future refactors cannot
  // accidentally bill extension consumption to the caller's memory space.
  if (event === "analyzer_usage") {
    return { attempted: false, ok: false };
  }

  const spaceId = extractSpaceIdFromPath(path);
  if (!spaceId || !usage || Object.keys(usage).length === 0) {
    return { attempted: false, ok: false };
  }
  const result = await reportCreditUsage(config, {
    SpaceId: spaceId,
    MemoryLevel: PROXY_MEMORY_LEVEL,
    MemoryDelta: 0,
    CreditDelta: computeCreditDelta(usage, pricingConfig, modelId, upstreamUrl),
  });
  if (result.ok) {
    return { attempted: true, ok: true, result };
  }
  const errorText = result.error ?? "unknown";
  const errorMessage =
    `spaceId=${spaceId} error=${errorText} resp=${JSON.stringify(result.response ?? null).slice(0, 200)}`;
  const errorHeader = sanitizeHeaderValue(`spaceId=${spaceId}; error=${errorText}`);
  return { attempted: true, ok: false, errorMessage, errorHeader, result };
}

/** Sanitize a string for use as an HTTP header value: strip CR/LF, cap length. */
function sanitizeHeaderValue(s: string): string {
  const cleaned = s.replace(/[\r\n]+/g, " ").trim();
  return cleaned.length > MAX_ERROR_HEADER_LEN
    ? cleaned.slice(0, MAX_ERROR_HEADER_LEN - 3) + "..."
    : cleaned;
}
