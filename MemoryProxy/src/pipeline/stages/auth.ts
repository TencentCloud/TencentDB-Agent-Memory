/**
 * stages/auth.ts — early-auth stage (Phase 1)。
 *
 * 提取自 4 处近乎相同的代码:
 *   - handler.ts:461-471
 *   - anthropicHandler.ts:544-553  (用 extractApiKey 支持 x-api-key)
 *   - codexHandler.ts:309-323      (显式 fallback x-api-key + 组 keyId)
 *   - workbuddyHandler.ts:1108-1124 (同 codex)
 *
 * 差异只有两点, 都保留:
 *   1. apiKey 提取源:
 *      - handler 只认 Bearer
 *      - anthropic/codex/wb 支持 Bearer + x-api-key fallback
 *      - 统一策略: 都支持 x-api-key fallback, handler 走 Bearer 时 x-api-key
 *        永远 undefined, 行为等价
 *   2. rejected 时错误 envelope 格式:
 *      - openai (handler/codex/wb): `{error: "..."}`
 *      - anthropic:                 `{type:"error",error:{type,message}}`
 *      - 由调用方 (protocol.buildErrorResponse) 决定, 本 stage 只返 rejected 结果
 *
 * ⚠️ 顺序保持: verifyUserKey 必须在 body parse 之前, 拒绝流量不消耗 body reader。
 */

import type { Context } from "hono";
import { verifyUserKey } from "../../auth.js";
import { extractBearerToken, apiKeyToKeyId } from "../../opik.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";

export interface AuthStageResult {
  /** Bearer/x-api-key 提取出来的原始 API key */
  apiKey: string;
  /** rejected=false 时保证非空; verifyUserKey 返回的 userId 或 fallback keyId */
  keyId: string;
  /** verifyUserKey 返回的 userId (可能为空字符串) */
  userId: string;
  /** URL 中提取的 spaceId (可能为空字符串) */
  spaceId: string;
  /** 只在 rejected=true 时有意义, 语义与 verifyUserKey 一致 */
  rejected: boolean;
  rejectReason?: string;
}

/**
 * API key 提取模式 (老 4 个 handler 各不相同, 迁移时保留):
 *   - "bearer-only" (handler.ts): 只认 Bearer, 忽略 x-api-key
 *   - "bearer-first" (codex/wb/utility): Bearer 优先, x-api-key 兜底
 *   - "xapi-first" (anthropic): x-api-key 优先, Bearer 兜底
 * 这三种模式在同时带两种 header 时结果不同 (anthropic 走 x-api-key,
 * codex/wb 走 Bearer)。stage 必须显式支持 3 种。
 */
export type ApiKeyExtractionMode = "bearer-only" | "bearer-first" | "xapi-first";

/**
 * 从 Hono Context 提取 API key。
 */
export function extractApiKeyFromContext(
  c: Context,
  mode: ApiKeyExtractionMode = "bearer-first",
): string {
  const xApiKey = c.req.header("x-api-key");
  const bearer = extractBearerToken(
    c.req.header("authorization") ?? c.req.header("Authorization") ?? "",
  );
  if (mode === "xapi-first") {
    if (xApiKey) return xApiKey;
    return bearer ?? "";
  }
  if (mode === "bearer-only") {
    return bearer ?? "";
  }
  // bearer-first (default)
  if (bearer) return bearer;
  if (xApiKey) return xApiKey;
  return "";
}

/**
 * Early auth stage — 在 body 解析之前跑, 拒绝的请求短路。
 *
 * 返回 `rejected: true` 时调用方应立即用 protocol.buildErrorResponse
 * 生成 401, 不要往下走。
 */
export async function stageAuth(
  c: Context,
  mode: ApiKeyExtractionMode = "bearer-first",
): Promise<AuthStageResult> {
  const apiKey = extractApiKeyFromContext(c, mode);
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const verify = await verifyUserKey(apiKey, spaceId);
  if (verify.rejected) {
    return {
      apiKey,
      keyId: "",
      userId: "",
      spaceId,
      rejected: true,
      rejectReason: verify.rejectReason,
    };
  }
  const userId = verify.userId;
  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");
  return { apiKey, keyId, userId, spaceId, rejected: false };
}
