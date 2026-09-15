/** Opik tracing client for context-proxy.
 *
 * Project name is derived from the request API key:
 *   SHA-256(apiKey) → hex → first 8 chars
 *
 * 可靠性设计（全部 fire-and-forget，绝不阻塞/改变业务响应）：
 * - 单次上报超时：config.opik.timeoutMs（默认 2000ms），超时即放弃；
 * - 熔断：连续失败 OPIK_BREAKER_FAILURE_THRESHOLD 次后暂停上报
 *   OPIK_BREAKER_OPEN_MS，期间静默跳过，避免后端不可用时拖垮请求侧；
 * - 日志限频：同类错误最多每 OPIK_WARN_THROTTLE_MS 输出一条 warn，
 *   防止故障期间逐请求刷日志；
 * - 端点前缀可配置：backend(8080) 用 /v1/private，前端(5173) 用
 *   /api/v1/private（config.opik.apiPrefix，默认 /v1/private）。
 */

import { createHash, randomBytes } from "node:crypto";
import type { ProxyConfig } from "./types.js";
import { log } from "./report/log.js";
import { archiveTrace, archiveSpan } from "./trace-archive.js";

export const OPIK_DEFAULT_API_PREFIX = "/v1/private";
export const OPIK_DEFAULT_TIMEOUT_MS = 2000;
const OPIK_BREAKER_FAILURE_THRESHOLD = 5;
const OPIK_BREAKER_OPEN_MS = 30_000;
const OPIK_WARN_THROTTLE_MS = 10_000;

/** 客户端级上报状态（跨请求共享，模块内单例）。 */
interface OpikClientState {
  consecutiveFailures: number;
  openUntilMs: number;
  lastWarnMs: number;
}

const clientState: OpikClientState = {
  consecutiveFailures: 0,
  openUntilMs: 0,
  lastWarnMs: 0,
};

/** 仅供测试：重置熔断/日志限频状态。 */
export function resetOpikClientForTests(): void {
  clientState.consecutiveFailures = 0;
  clientState.openUntilMs = 0;
  clientState.lastWarnMs = 0;
}

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

/** 同一轮用户提问（sessionKey + turnSeq）的稳定分组标签。
 *  工具循环产生的多条 HTTP 请求会算出相同的 (sessionKey, turnSeq)，
 *  因此该标签一致，可在 Opik 中按 turn:<hash> 过滤同一次提问的全部请求。
 */
export function opikTurnTag(sessionKey: string, turnSeq: number): string {
  const hash = createHash("sha256")
    .update(`${sessionKey}:${turnSeq}`)
    .digest("hex")
    .slice(0, 16);
  return `turn:${hash}`;
}

/** 同一轮用户提问的确定性 Opik traceId（UUID v7 格式）。
 *  同一 (sessionKey, turnSeq) 在任意请求/实例都得到同一 ID，
 *  使工具循环产生的多条 HTTP 请求能挂到同一条 trace 下。
 *  已在本机 Opik 验证：同 ID 重复 POST 幂等（不重复、不报错），
 *  多 span 同 trace 可正常展示。
 */
export function opikTurnTraceId(sessionKey: string, turnSeq: number): string {
  const digest = createHash("sha256")
    .update(`${sessionKey}:${turnSeq}`)
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x70; // version 7
  digest[8] = (digest[8] & 0x3f) | 0x80; // variant 10xx
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 相同内容的用户问题指纹标签。
 *  只用于统计/过滤，绝不参与 traceId 派生：同一内容在不同会话/轮次仍是
 *  不同的执行 trace，但都会带同一个 question:<hash>，便于统计重复问题。
 */
export function opikQuestionTag(query: string | null | undefined): string | null {
  const normalized = String(query ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!normalized) return null;
  const hash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
  return `question:${hash}`;
}

interface OpikTraceInput {
  traceId: string;
  projectName: string;
  name: string;
  startTime: string; // ISO 8601
  input: Record<string, unknown>;
  tags?: string[];
  /** 结构化上下文（agent / session / 注入统计 / 工具交互等），原样写入 trace.metadata。 */
  metadata?: Record<string, unknown>;
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
  /** 结构化上下文，原样写入 span.metadata。 */
  metadata?: Record<string, unknown>;
  /** Fork to a second project (e.g. "request_log"). Requires forkTraceId. */
  forkProjectName?: string;
  /** Independent trace ID for the forked span (different from main traceId). */
  forkTraceId?: string;
  /** Metadata attached to forked span. */
  forkMetadata?: Record<string, unknown>;
}

/** 归一化 REST API 前缀（必须以 "/" 开头，去尾部斜杠）。 */
export function opikApiPrefix(config: ProxyConfig): string {
  const raw = config.opik.apiPrefix?.trim();
  if (!raw) return OPIK_DEFAULT_API_PREFIX;
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  const stripped = normalized.replace(/\/+$/, "");
  return stripped || OPIK_DEFAULT_API_PREFIX;
}

/** 拼接完整上报 URL：`{base}{prefix}{resource}`，resource 形如 "/traces"、"/spans"。 */
export function opikEndpoint(config: ProxyConfig, resource: string): string {
  const base = config.opik.url.replace(/\/+$/, "");
  const prefix = opikApiPrefix(config);
  const suffix = resource.startsWith("/") ? resource : `/${resource}`;
  return `${base}${prefix}${suffix}`;
}

function opikHeaders(config: ProxyConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.opik.apiKey) headers["Authorization"] = `Bearer ${config.opik.apiKey}`;
  return headers;
}

function breakerOpen(nowMs = Date.now()): boolean {
  return nowMs < clientState.openUntilMs;
}

function recordOpikResult(success: boolean, nowMs = Date.now()): void {
  if (success) {
    clientState.consecutiveFailures = 0;
    return;
  }
  clientState.consecutiveFailures += 1;
  if (clientState.consecutiveFailures >= OPIK_BREAKER_FAILURE_THRESHOLD) {
    clientState.openUntilMs = nowMs + OPIK_BREAKER_OPEN_MS;
    clientState.consecutiveFailures = 0;
  }
}

/** 同类错误日志限频：默认每 10s 至多一条 warn。 */
function opikWarnThrottled(event: string, fields: Record<string, unknown>): void {
  const now = Date.now();
  if (now - clientState.lastWarnMs < OPIK_WARN_THROTTLE_MS) return;
  clientState.lastWarnMs = now;
  log.warn(event, fields);
}

interface OpikRequest {
  method: "POST" | "PATCH";
  url: string;
  body: Record<string, unknown>;
  /** 日志事件名（opik.*_error / *_failed）。 */
  event: string;
}

/** 统一上报入口：超时 + 熔断 + 限频日志；任何异常都不向外抛。 */
async function sendOpikRequest(config: ProxyConfig, req: OpikRequest): Promise<void> {
  if (breakerOpen()) return;
  const timeoutMs =
    typeof config.opik.timeoutMs === "number" && config.opik.timeoutMs > 0
      ? config.opik.timeoutMs
      : OPIK_DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: opikHeaders(config),
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      recordOpikResult(false);
      opikWarnThrottled(`${req.event}_error`, { status: res.status, body: text.slice(0, 200) });
      return;
    }
    recordOpikResult(true);
  } catch (err) {
    recordOpikResult(false);
    const detail = err instanceof Error && err.name === "TimeoutError" ? "timeout" : String(err);
    opikWarnThrottled(`${req.event}_failed`, { error: detail });
  }
}

/** POST a new trace to Opik (fire-and-forget).
 *  Returns the forkTraceId if forkProjectName was set (different ID than main trace),
 *  or empty string otherwise. The main trace is always created with input.traceId.
 */
export function opikCreateTrace(
  config: ProxyConfig,
  input: OpikTraceInput,
): string {
  // 本地 JSONL 归档（独立于 Opik 远程上报，由 traceArchive.enabled 控制）
  archiveTrace({
    type: "trace",
    id: input.traceId,
    name: input.name,
    projectName: input.projectName,
    startTime: input.startTime,
    input: input.input,
    tags: input.tags,
  });

  if (!config.opik.enabled || !config.opik.url) return "";

  const url = opikEndpoint(config, "/traces");
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
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    traceBody.metadata = input.metadata;
  }

  void sendOpikRequest(config, {
    method: "POST",
    url,
    body: traceBody,
    event: "opik.create_trace",
  });

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
    void sendOpikRequest(config, {
      method: "POST",
      url,
      body: forkBody,
      event: "opik.create_trace",
    });
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

  void sendOpikRequest(config, {
    method: "PATCH",
    url: opikEndpoint(config, `/traces/${update.traceId}`),
    body: {
      project_name: update.projectName,
      workspace_name: "default",
      end_time: update.endTime,
      output: update.output,
      usage: update.usage, // raw, unmodified
    },
    event: "opik.update_trace",
  });
}

/** POST a LLM span under an existing trace (fire-and-forget).
 *  This is what populates the "Messages" panel in Opik UI.
 */
export function opikCreateLlmSpan(
  config: ProxyConfig,
  span: OpikLlmSpan,
): void {
  // 本地 JSONL 归档（独立于 Opik 远程上报，由 traceArchive.enabled 控制）
  archiveSpan({
    type: "span",
    id: uuidv7(),
    traceId: span.traceId,
    name: span.name,
    projectName: span.projectName,
    model: span.model,
    startTime: span.startTime,
    endTime: span.endTime,
    input: span.inputMessages,
    output: span.outputMessage,
    usage: span.usage,
    tags: span.tags,
  });

  if (!config.opik.enabled || !config.opik.url) return;

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
  if (span.metadata && Object.keys(span.metadata).length > 0) {
    body.metadata = span.metadata;
  }

  void sendOpikRequest(config, {
    method: "POST",
    url: opikEndpoint(config, "/spans"),
    body,
    event: "opik.create_llm_span",
  });

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
    void sendOpikRequest(config, {
      method: "POST",
      url: opikEndpoint(config, "/spans"),
      body: forkBody,
      event: "opik.create_llm_span",
    });
  }
}

export { uuidv7 };
