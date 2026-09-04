/**
 * Auxiliary endpoint handler: 轻量透传处理器。
 *
 * 用于处理不需要路由决策的白名单端点：
 *  - `/v1/messages/count_tokens`（Anthropic）
 *  - `/v1/embeddings`（OpenAI）
 *  - `/v1/completions`（OpenAI 旧协议）
 *
 * 与主 handler (`handleAnthropicMessages` / `handleChatCompletions`) 的区别：
 *  - **跳过** 路由分析器与模型路由（这些端点无对话推理语义）
 *  - **跳过** opik/langfuse trace（这些端点不构成对话回合，避免可观测性噪音）
 *  - **保留** 鉴权头（apiKey）注入、credit 计算、JSONL/ClickHouse usage 落表
 *
 * 本 handler 的所有 body 都以 raw `ArrayBuffer` 形式透传，仅在 log/metadata 层面
 * 尝试解析 JSON 提取 `model` 字段（失败则回落为 "unknown"）。响应亦原样返回给客户端
 * （非 stream：完整读取后透传；stream：`ReadableStream` 直接 pipe）。
 */

import type { Context } from "hono";
import { createPipeline, writeLog } from "./logger.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import type { ProxyConfig } from "./types.js";
import {
  tryReportCreditFromPath,
  extractSpaceIdFromPath,
} from "./credit-reporter.js";
import { matchWhitelistEndpoint, type WhitelistEndpoint } from "./routes/whitelist.js";
import { joinUrl } from "./guard-adapter.js";
import { log } from "./report/log.js";
import { verifyUserKey } from "./auth.js";
import { matchSystemUserByUserId, hasSystemUsers } from "./systemUser.js";
import { handleSystemUserPassthrough } from "./systemUserPassthrough.js";

/** Hop-by-hop headers 与 host header：不能透传到 upstream。 */
const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  // Auth-decoupling header — never forward to upstream (prevents user_key leak)
  "x-mem-user-key",
]);

/** 响应头中不应回传给客户端的头（避免 stream 长度不一致等问题）。 */
const SKIP_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/**
 * 构造转发到上游的请求头。
 *
 * 与主 handler 的差异：辅助端点不涉及路由的 auth override，只需按端点
 * 协议注入 `upstream.apiKey`：
 *  - `anthropic` → `x-api-key`（同时清除 `authorization`）
 *  - `openai`    → `Authorization: Bearer`
 */
function buildAuxUpstreamHeaders(
  c: Context,
  config: ProxyConfig,
  entry: WhitelistEndpoint,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = headers["content-type"] ?? "application/json";

  if (config.upstream.apiKey) {
    if (entry.protocol === "anthropic") {
      headers["x-api-key"] = config.upstream.apiKey;
      delete headers["authorization"];
    } else {
      headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
      delete headers["x-api-key"];
    }
  }
  return headers;
}

/** 过滤响应头（剥离长度/编码相关字段），返回可直接下发的 Headers 对象。 */
function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

/**
 * 从 request body 尝试解析出 `model` 字段用于日志。
 * body 非 JSON 或不含 model 时返回 "unknown"（不抛出）。
 */
function extractModelId(bodyText: string): string {
  if (!bodyText) return "unknown";
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof parsed.model === "string" && parsed.model) return parsed.model;
  } catch {
    // ignore — non-JSON body is allowed for passthrough
  }
  return "unknown";
}

/**
 * 从响应文本中提取 `usage` 字段（若存在）。
 *
 * 通用形状：
 *  - Anthropic count_tokens：整个 body 就是 `{ input_tokens: N }` — 直接作为 usage
 *  - OpenAI embeddings：`{ data: [...], usage: { prompt_tokens, total_tokens } }`
 *  - 其他：尝试读顶层 `usage` 字段
 *  - 无法解析：返回 `null`
 */
function extractUsageFromResponse(
  respText: string,
  entry: WhitelistEndpoint,
): Record<string, unknown> | null {
  if (!respText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(respText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // Anthropic count_tokens 的响应就是 { input_tokens: N }，没有 usage 包装
  if (entry.pathSuffix === "/v1/messages/count_tokens") {
    if (typeof obj.input_tokens === "number") return obj;
    return null;
  }

  // OpenAI 系列（embeddings / completions）：usage 在顶层 usage 字段里
  if (obj.usage && typeof obj.usage === "object") {
    return obj.usage as Record<string, unknown>;
  }
  return null;
}

/**
 * Auxiliary endpoint handler.
 *
 * 请求生命周期：
 *  1. 从白名单表匹配当前路径（防御性；正常情况路由层已保证匹配）
 *  2. 提取 apiKey → keyId
 *  3. 读取 raw body（不解析），仅提取 `model` 字段用于日志
 *  4. `joinUrl` 拼接 upstream URL
 *  5. 按协议注入鉴权头
 *  6. fetch upstream（不 retry，简化处理）
 *  7. 分流：
 *     - stream 响应 → 直接 pipe body 回客户端（本期不解析 usage）
 *     - non-stream → 完整读取 → 提取 usage → credit 计算 + JSONL 落表
 *  8. 响应 status/headers/body 原样透传
 */
export async function handleAuxiliaryEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();

  const entry = matchWhitelistEndpoint(c.req.path);
  if (!entry) {
    // Defensive: server.ts 应保证只有白名单路径路由到本 handler。
    // 若到达此处说明配置或路由不一致，返回 404 便于快速定位。
    return c.json({ error: "Unregistered endpoint" }, 404);
  }

  // 1. 鉴权（先做本地 keyId 解析，再走 auth 服务校验以与主 handler 对对称）
  // When `auth.userKeyHeader` is configured, the user_key (sk-mem-*) moves to
  // that header, freeing x-api-key / Authorization to carry the corporate
  // gateway key for upstream passthrough.
  const apiKey = config.auth.userKeyHeader
    ? (c.req.header(config.auth.userKeyHeader) ?? c.req.header(config.auth.userKeyHeader.toLowerCase()) ?? "")
    : (c.req.header("x-api-key") ??
       extractBearerToken(c.req.header("authorization") ?? c.req.header("Authorization") ?? "") ??
       "");

  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // 与主 handler 保持一致：调用 auth 服务校验，未通过则 401。
  // spaceId 来源于请求路径 /proxy/<spaceId>/...；无路径前缀时为 ""。
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } =
    await verifyUserKey(apiKey, spaceId);
  if (userKeyRejected) {
    return c.json(
      { error: `Authentication failed: ${rejectReason ?? "unknown"}` },
      401,
    );
  }
  if (userId) keyId = userId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Auxiliary endpoints (count_tokens / embeddings / completions / moderations)
  // also bypass the standard aux flow for internal service accounts. Match
  // is by userId resolved from verifyUserKey; auth-disabled requests (userId
  // == "") never match. Body has NOT been read yet — passthrough owns the
  // byte stream end-to-end.
  if (hasSystemUsers()) {
    const sysMatch = matchSystemUserByUserId(userId);
    if (sysMatch) {
      return handleSystemUserPassthrough(c, config, sysMatch);
    }
  }

  // 2. 读取 raw body（bytes 级透传）
  const rawBody = await c.req.arrayBuffer();
  const bodyText = new TextDecoder().decode(rawBody);
  const modelId = extractModelId(bodyText);

  // 3. 拼接 upstream URL（复用 joinUrl，天然消费白名单表）
  const upstreamUrl = joinUrl(config.upstream.url, c.req.path);

  // 4. 构造上游请求头（按端点协议注入鉴权）
  const upstreamHeaders = buildAuxUpstreamHeaders(c, config, entry);

  // 5. Pipeline log（简化：只发关键事件）
  const pipe = createPipeline(config, traceId, modelId);
  pipe.info(
    "AUX_ENDPOINT",
    `${entry.pathSuffix} → ${entry.upstreamEndpoint} (${entry.protocol})`,
  );
  pipe.forwardStart();

  // 6. 转发（辅助端点简化：不 retry）
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: rawBody,
    });
  } catch (err: unknown) {
    pipe.error("AUX_FORWARD", err instanceof Error ? err : new Error(String(err)));
    return c.json(
      { error: "Upstream request failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
  pipe.forwardDone(upstreamResp.status);

  // 7. 分流：stream vs non-stream
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isStream = contentType.includes("event-stream");

  if (isStream) {
    // Stream 分支：直接 pipe，本期不做 SSE tap 提取 usage
    // （credit 会在客户端断开或 tap 逻辑二期补齐时再实现）
    log.debug("aux.stream.passthrough", { path: c.req.path, upstreamUrl });
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  // Non-stream：完整读取 body → 提取 usage → credit
  const respBuf = await upstreamResp.arrayBuffer();
  const respText = new TextDecoder().decode(respBuf);
  const usage = extractUsageFromResponse(respText, entry);

  if (usage && upstreamResp.ok) {
    // credit 上报（辅助端点走通用 credit-reporter）
    try {
      await tryReportCreditFromPath(
        config.creditReport,
        c.req.path,
        usage,
        config.creditPricing,
        modelId,
        upstreamUrl,
        "usage",
      );
    } catch (err: unknown) {
      log.error(
        "aux.credit_report_failed",
        { path: c.req.path, upstreamUrl },
        err instanceof Error ? err : new Error(String(err)),
      );
    }

    // JSONL + ClickHouse usage 落表（复用主 handler 的路径）
    writeLog(config, {
      timestamp: startTime,
      event: "usage",
      modelId,
      keyId,
      sessionKey: keyId, // 辅助端点无 session 概念，用 keyId 兜底
      upstreamUrl,
      stream: false,
      usage,
    });
  }

  pipe.responseDone(usage);

  // 8. 原样透传响应
  return new Response(respBuf, {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}
