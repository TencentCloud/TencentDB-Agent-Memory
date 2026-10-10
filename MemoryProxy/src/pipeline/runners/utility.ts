/**
 * Utility endpoint runner — 完整实现 (Phase 4)。
 *
 * 迁移自 auxiliaryHandler.ts::handleAuxiliaryEndpoint (337 行)。
 * 与老实现语义 1:1 等价, 但改由 pipeline runner 承载。
 * 复用 pipeline 已提取的 stages: stageAuth, stageCredit。
 *
 * ⚠️ 修的 latent leak (addendum §2.4): 老版 HOP_BY_HOP 版本 → 新版
 * WITH_INTERNAL 版本, 防 x-tdai-user-key 透传给上游。
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { createPipeline, writeLog } from "../../logger.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "../../opik.js";
import {
  tryReportCreditFromPath,
  extractSpaceIdFromPath,
} from "../../credit-reporter.js";
import { matchWhitelistEndpoint, type WhitelistEndpoint } from "../../routes/whitelist.js";
import { joinUrl } from "../../guard-adapter.js";
import { log } from "../../report/log.js";
import { verifyUserKey } from "../../auth.js";
import { stageAuth } from "../stages/auth.js";
import { stageSystemUser } from "../stages/system-user.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import { handleSystemUserPassthrough } from "../../systemUserPassthrough.js";
import {
  getInstanceUpstreamConfigs,
  resolveForAgent,
} from "../../instance-upstream-cache.js";
import { SKIP_REQUEST_HEADERS_WITH_INTERNAL, SKIP_RESPONSE_HEADERS, filterResponseHeaders } from "../../common/constants.js";

function buildAuxUpstreamHeaders(
  c: Context,
  config: ProxyConfig,
  entry: WhitelistEndpoint,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS_WITH_INTERNAL.has(k.toLowerCase())) {
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

function extractModelId(bodyText: string): string {
  if (!bodyText) return "unknown";
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof parsed.model === "string" && parsed.model) return parsed.model;
  } catch { /* non-JSON allowed */ }
  return "unknown";
}

function extractUsageFromResponse(
  respText: string,
  entry: WhitelistEndpoint,
): Record<string, unknown> | null {
  if (!respText) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(respText); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (entry.pathSuffix === "/v1/messages/count_tokens") {
    if (typeof obj.input_tokens === "number") return obj;
    return null;
  }
  if (obj.usage && typeof obj.usage === "object") return obj.usage as Record<string, unknown>;
  return null;
}

/**
 * runUtilityPipeline — count_tokens / embeddings / completions / moderations 完整链路,
 * 与 handleAuxiliaryEndpoint 语义等价。
 */
export async function runUtilityPipeline(c: Context, config: ProxyConfig): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();

  const entry = matchWhitelistEndpoint(c.req.path);
  if (!entry) return c.json({ error: "Unregistered endpoint" }, 404);

  // 1. Auth (via shared stageAuth)
  // 老 auxiliary 是 x-api-key 优先 (与 stage 的 Bearer 优先反过来), 但两者结果集合等价
  // (若两个都在时 handler 用 x-api-key, stage 用 Bearer) —— 客户端场景不会同时带两个,
  // 所以这里改用 stageAuth 保持 zero-regression。
  const auth = await stageAuth(c, "xapi-first");
  const apiKey = auth.apiKey;
  const spaceId = auth.spaceId;
  const userId = auth.userId;
  if (auth.rejected) {
    return c.json({ error: `Authentication failed: ${auth.rejectReason ?? "unknown"}` }, 401);
  }
  const keyId = auth.keyId;

  // systemUser 短路 (utility 无 body, stage 内部 undefined)
  const sysResp = await stageSystemUser(c, config, userId);
  if (sysResp) return sysResp;

  // 2. body 读取 (raw bytes, 不解析 JSON, 只提 model)
  const rawBody = await c.req.arrayBuffer();
  const bodyText = new TextDecoder().decode(rawBody);
  const modelId = extractModelId(bodyText);

  // 3. upstream URL + headers
  let upstreamUrl = joinUrl(config.upstream.url, c.req.path);
  const upstreamHeaders = buildAuxUpstreamHeaders(c, config, entry);

  // instance upstream override (aux 跟 conversation config)
  // 命中 custom 组时同时置 skipCreditReport —— 与 stages/instance-upstream-override.ts
  // 的语义一致: custom upstream 由用户自付, 不算平台账。
  let skipCreditReport = false;
  {
    const instanceConfigs = await getInstanceUpstreamConfigs(config.coreSkill, spaceId, config.instanceUpstream);
    const agentFromPath = c.req.path.split("/").filter(Boolean)[0] ?? undefined;
    const resolution = resolveForAgent(instanceConfigs, agentFromPath ?? "");
    if (resolution.kind === "override") {
      const row = resolution.row;
      upstreamUrl = joinUrl(row.base_url, c.req.path);
      skipCreditReport = true;
      if (row.mode === "custom_unified" && row.api_key) {
        if (entry.protocol === "anthropic") {
          upstreamHeaders["x-api-key"] = row.api_key;
          delete upstreamHeaders["authorization"];
        } else {
          upstreamHeaders["authorization"] = `Bearer ${row.api_key}`;
          delete upstreamHeaders["x-api-key"];
        }
      }
    }
  }

  // 4. pipe log + forward
  const pipe = createPipeline(config, traceId, modelId);
  pipe.info("AUX_ENDPOINT", `${entry.pathSuffix} → ${entry.upstreamEndpoint} (${entry.protocol})`);
  pipe.forwardStart();

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: rawBody,
    });
  } catch (err: unknown) {
    pipe.error("AUX_FORWARD", err instanceof Error ? err : new Error(String(err)));
    return c.json({
      error: "Upstream request failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 502);
  }
  pipe.forwardDone(upstreamResp.status, upstreamResp.headers.get("x-request-id") ?? undefined);

  // 5. stream vs non-stream
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isStream = contentType.includes("event-stream");

  if (isStream) {
    log.debug("aux.stream.passthrough", { path: c.req.path, upstreamUrl });
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  const respBuf = await upstreamResp.arrayBuffer();
  const respText = new TextDecoder().decode(respBuf);
  const usage = extractUsageFromResponse(respText, entry);

  if (usage && upstreamResp.ok) {
    // custom upstream (instance 配了 override 组) 不上报计费 —— 与
    // anthropic/openai-chat/codex/workbuddy 的 skipCreditReport 语义对齐。
    if (skipCreditReport) {
      log.debug("aux.credit_report_skipped", { path: c.req.path, upstreamUrl, reason: "custom_upstream" });
    } else {
      try {
        await tryReportCreditFromPath(
          config.creditReport,
          c.req.path,
          usage,
          config.creditPricing,
          modelId,
          upstreamUrl,
          "usage",
          new Date(startTime),
          { ...pipe.ids(), sessionKey: keyId },
        );
      } catch (err: unknown) {
        log.error("aux.credit_report_failed",
          { path: c.req.path, upstreamUrl },
          err instanceof Error ? err : new Error(String(err)));
      }
    }
    writeLog(config, {
      timestamp: startTime,
      event: "usage",
      modelId,
      keyId,
      sessionKey: keyId,
      upstreamUrl,
      stream: false,
      usage,
      requestReceivedAt: startTime,
    });
  }

  pipe.responseDone(usage);

  return new Response(respBuf, {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}
