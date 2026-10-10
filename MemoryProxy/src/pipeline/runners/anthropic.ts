/**
 * Anthropic Messages API handler.
 * Supports /v1/messages endpoint with streaming (SSE) and non-streaming modes.
 * Integrates with routing module, Opik observability, and JSONL logging.
 *
 * This handler uses ForwardTarget opaquely — no routing semantics
 * leak into the handler. All routing logic is encapsulated in the private module.
 */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "../../logger.js";
import {
  apiKeyToKeyId,
  opikCreateLlmSpan,
  opikCreateTrace,
  uuidv7,
} from "../../opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import { countHumanTurns, resolveMonotonicTurnSeq } from "../../turnSeq.js";
import type { ProxyConfig } from "../../types.js";
import {
  resolveForwardTarget,
  resolveSessionKey,
  resolveLatestUserQuery,
  reportAnalyzerTrace,
  type ForwardTarget,
} from "../../guard-adapter.js";
import { hasCostGuardMarker, isLegacyProxyPath, matchWhitelistEndpoint, resolveCostGuardMode } from "../../routes/whitelist.js";
import { writeRequestLog } from "../../requestLog.js";
import { prepareUpstreamRequest, notifyUpstreamResponse } from "../../request-prepare-adapter.js";
import {
  createCfqStripStream,
  createCfqStripObserver,
  stripCfqFromResponseText,
} from "../../common/cfq-strip.js";
import { tryReportCreditFromPath, extractSpaceIdFromPath } from "../../credit-reporter.js";
import {
  getInstanceUpstreamConfigs,
  resolveForAgent,
  resolveExtraction,
  shouldOverride,
  type Resolution,
} from "../../instance-upstream-cache.js";
import { resolveModelId, isModelInPricing } from "../../pricing.js";
import { inspectAndRecord } from "../../identity.js";
import { writeFailedReportRaw } from "../../clickhouse.js";
import { verifyUserKey } from "../../auth.js";
import { stageAuth } from "../stages/auth.js";
import { stageParseBody } from "../stages/parse-body.js";
import { stageModelGate } from "../stages/model-gate.js";
import {
  stageWriteUsageLog,
  stageRecordTokenUsage,
  stageEmitModelIntent,
  stageOpikStreamSpan,
} from "../stages/stream-finalize.js";
import { stagePrewarmInjection } from "../stages/prewarm-injection.js";
import { stageAssetCapabilities } from "../stages/asset-capabilities.js";
import { stageSessionBypass } from "../stages/session-bypass.js";
import { stageSessionInitOrchestrate } from "../stages/session-init-orchestrate.js";
import { stageCredit } from "../stages/credit.js";
import { stageSystemUser } from "../stages/system-user.js";
import { stageBuildLangfuseTurnContext, stageReportAnalyzerTrace } from "../stages/observability.js";
import { stageSessionResetPreHook } from "../stages/session-reset-pre-hook.js";
import { stageResponseTailFix } from "../stages/response-tail-fix.js";
import { stageSessionResetConfirmation } from "../stages/session-reset-confirmation.js";
import { stageMemCommandIntercept } from "../stages/mem-command-intercept.js";
import { stageInjectionRunner } from "../stages/injection-runner.js";
import { stageInstanceUpstreamEarly } from "../stages/instance-upstream-early.js";
import { stageInstanceUpstreamOverride } from "../stages/instance-upstream-override.js";
import { stageResolveTargetFull } from "../stages/resolve-target-full.js";
import { stageResolveUserId } from "../stages/resolve-user-id.js";
import { stageForwardWithRetry } from "../stages/forward-with-retry.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import { handleSystemUserPassthrough } from "../../systemUserPassthrough.js";
import { TdaiClient, buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../../tdai/recorder.js";
import { trackWrite, withL0Retry } from "../../tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { emitModelIntentTelemetry } from "../../session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "../../extraction-gate.js";
import type { CcRequestKind } from "../../common/cc-request-classifier.js";
import { buildRequestDebugMetadata } from "../../common/langfuse-debug.js";
import { resolveAgentAdapter } from "../../agent-adapters/index.js";
import { resolveAgentStrategy } from "../strategies/agent/index.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "../../rate-limit/guard.js";

// SKIP header sets 已合并到 common/constants.ts
// anthropic 老行为: WITH_INTERNAL 5 项 (含 x-tdai-user-key 泄漏保护)
import { SKIP_REQUEST_HEADERS_WITH_INTERNAL as SKIP_REQUEST_HEADERS, filterResponseHeaders } from "../../common/constants.js";

/**
 * Build a per-request TdaiClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.tdai.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
const createTdaiClient = buildTdaiClientForRequest;

/**
 * Normalize Anthropic top-level `system` field into a plain string for
 * observability. Anthropic accepts either a string or an array of content
 * blocks; here we join `text` blocks' text with "\n" and JSON-stringify
 * anything else. Returns "" when nothing textual is present.
 */
function stringifyAnthropicSystem(system: unknown): string {
  if (system === undefined || system === null) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    const parts: string[] = [];
    for (const block of system) {
      const b = block as Record<string, unknown>;
      if (b && b.type === "text" && typeof b.text === "string" && b.text) {
        parts.push(b.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(system);
}

/**
 * Build the `input` payload for Langfuse / Opik. Two modes:
 *
 * - Normal mode (default): calls `flattenAnthropicMessagesForOpik` — content
 *   arrays are stringified for compact display. Loses `cache_control` markers,
 *   `thinking` blocks with signatures, native `tool_use`/`tool_result` shape.
 *
 * - Debug mode (`langfuse.debug=true`): passes the raw Anthropic body straight
 *   through, preserving every native structure. Use when investigating cache
 *   markers, thinking-signature issues, or request classification. Costs 2-5x
 *   more upload bandwidth + Langfuse storage — leave off in production.
 */
export function buildLangfuseInput(
  messages: unknown[],
  system: unknown,
  debug: boolean,
): unknown {
  if (debug) {
    // Preserve original shape end-to-end. Prepend a synthetic system message
    // when it's non-empty so the display order matches other consumers.
    const out: unknown[] = [];
    if (system !== undefined && system !== null && system !== "") {
      out.push({ role: "system", content: system });
    }
    return out.concat(messages);
  }
  return flattenAnthropicMessagesForOpik(messages, system);
}

/**
 * Flatten Anthropic messages for Opik / Langfuse display.
 *
 * Anthropic puts the system prompt on `body.system` (not inside `messages`),
 * so callers should pass it explicitly — otherwise the reported input omits
 * the system prompt entirely. When provided and non-empty, a synthetic
 * `{role:"system", content}` message is prepended to the result.
 */
export function flattenAnthropicMessagesForOpik(
  messages: unknown[],
  system?: unknown,
): unknown[] {
  const result: unknown[] = [];
  const systemText = stringifyAnthropicSystem(system);
  if (systemText) {
    result.push({ role: "system", content: systemText });
  }
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      result.push({ role, content: JSON.stringify(content) });
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_use") {
          toolCalls.push(b);
        } else if (b.type === "thinking" && b.thinking) {
          textParts.push(`[thinking] ${(b.thinking as string).slice(0, 200)}`);
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "assistant", content: textParts.join("\n") });
      }
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown>;
        const inputStr = typeof t.input === "string" ? t.input : JSON.stringify(t.input);
        result.push({
          role: "assistant",
          content: JSON.stringify({ tool_call_id: t.id, tool_name: t.name, input: inputStr }, null, 2),
        });
      }
    } else if (role === "user") {
      const textParts: string[] = [];
      const toolResults: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text") {
          textParts.push(b.text as string);
        } else if (b.type === "tool_result") {
          toolResults.push(b);
        } else {
          textParts.push(JSON.stringify(b));
        }
      }
      if (textParts.length > 0) {
        result.push({ role: "user", content: textParts.join("\n") });
      }
      for (const tr of toolResults) {
        const t = tr as Record<string, unknown>;
        let resultContent: string;
        if (typeof t.content === "string") {
          resultContent = t.content;
        } else if (Array.isArray(t.content)) {
          resultContent = (t.content as Record<string, unknown>[])
            .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          resultContent = JSON.stringify(t.content);
        }
        result.push({
          role: "tool",
          content: JSON.stringify({ tool_call_id: t.tool_use_id, is_error: t.is_error ?? false, result: resultContent }, null, 2),
        });
      }
    } else {
      const merged = content.map((b: unknown) => {
        const block = b as Record<string, unknown>;
        if (block.type === "text") return block.text as string;
        return JSON.stringify(block);
      }).join("\n");
      result.push({ role, content: merged });
    }
  }
  return result;
}

/** Extract Anthropic API key from request headers (x-api-key or Authorization Bearer). */
function extractApiKey(c: Context): string {
  const xApiKey = c.req.header("x-api-key");
  if (xApiKey) return xApiKey;

  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return "";
}

/**
 * Heuristically decide whether a `thinking` block carries a valid native
 * Anthropic/Bedrock signature.
 */
function hasValidThinkingSignature(block: Record<string, unknown>): boolean {
  const sig = block.signature;
  if (typeof sig !== "string" || sig.length < 40) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sig)) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/.test(sig);
}

/**
 * Sanitize `thinking` blocks across all assistant messages.
 *
 * Exported for unit testing.
 */
export function sanitizeThinkingBlocks(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; removed: number } {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, removed: 0 };

  let removed = 0;
  let changed = false;

  const newMessages = messages.map((msg) => {
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant" || !Array.isArray(m.content)) return msg;

    let msgChanged = false;
    const newContent = (m.content as unknown[]).filter((block) => {
      const b = block as Record<string, unknown>;
      const isThinking = b.type === "thinking" || b.type === "redacted_thinking";
      if (!isThinking) return true;
      if (hasValidThinkingSignature(b)) return true;
      removed += 1;
      msgChanged = true;
      return false;
    });

    if (!msgChanged) return msg;
    changed = true;
    return { ...m, content: newContent };
  });

  if (!changed) return { body, removed: 0 };
  return { body: { ...body, messages: newMessages }, removed };
}

/**
 * Build upstream body from original body + cost guard overrides.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): { body: Record<string, unknown>; sanitizedCount: number } {
  let result = body;
  if (target.bodyOverrides) {
    result = { ...result, ...target.bodyOverrides };
  }
  const sanitized = sanitizeThinkingBlocks(result);
  return { body: sanitized.body, sanitizedCount: sanitized.removed };
}

/**
 * Build upstream headers from request headers + cost guard auth overrides.
 */
function buildUpstreamHeaders(
  c: Context,
  _config: ProxyConfig,
  target: ForwardTarget,
  sessionKey?: string,
  effectiveApiKey?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  headers["content-type"] = "application/json";

  // `effectiveApiKey` is pre-resolved by the caller according to the
  // per-agent fallback rule (see the resolveEffectiveApiKey call site).
  //   - non-empty string → inject as server-side key, drop client's own
  //   - empty/undefined  → passthrough: keep whatever the client sent
  // The cost-guard extension can still fully override via target.authHeaders.
  if (effectiveApiKey && !target.authHeaders) {
    headers["x-api-key"] = effectiveApiKey;
    delete headers["authorization"];
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
      if (k === "x-api-key") delete headers["authorization"];
      if (k === "authorization") delete headers["x-api-key"];
    }
  }

  if (sessionKey) {
    headers["x-vertex-ai-session-id"] = sessionKey;
  }
  return headers;
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 * anthropic 版本: retryBody = originalBody (不覆写 model), timeout 恒开。
 * 委托 stageForwardWithRetry, 独有 4-md5 debug (cache_control anchor) 保留在 caller。
 */
async function forwardWithRetry(
  target: ForwardTarget,
  upstreamHeaders: Record<string, string>,
  upstreamBody: Record<string, unknown>,
  originalBody: Record<string, unknown>,
  originalHeaders: Record<string, string>,
  pipe: ReturnType<typeof createPipeline>,
  forwardTimeoutMs: number,
  sessionKeyForDebug?: string,
  rateLimitContext?: { config: ProxyConfig; instanceId?: string },
): Promise<{ resp: Response; retried: boolean }> {
  // ── anthropic 独有 md5 debug (cache_control anchor + sys 双 md5) ──
  // 用于观测 KV cache 命中: cache 前缀 bytes 一致才命中。
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const sys = (upstreamBody as { system?: unknown }).system;
      const sysFullStr = sys === undefined ? "" : JSON.stringify(sys);
      const sysTextStr = typeof sys === "string"
        ? sys
        : Array.isArray(sys)
          ? sys.map((b) => (b as { text?: string }).text ?? "").join("\n")
          : "";
      const msgs = (upstreamBody as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      let anchorIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const content = msgs[i]?.content;
        if (Array.isArray(content)) {
          const hasCache = content.some((b) => b && typeof b === "object" && "cache_control" in (b as object));
          if (hasCache) { anchorIdx = i; break; }
        }
      }
      const prefixEnd = anchorIdx >= 0 ? anchorIdx + 1 : msgs.length;
      const msgsPrefixStr = JSON.stringify(msgs.slice(0, prefixEnd));
      const sysFullMd5 = createHash("md5").update(sysFullStr).digest("hex").slice(0, 12);
      const sysTextMd5 = createHash("md5").update(sysTextStr).digest("hex").slice(0, 12);
      const msgsPrefixMd5 = createHash("md5").update(msgsPrefixStr).digest("hex").slice(0, 12);
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} sysBytes=${sysFullStr.length} sysFullMd5=${sysFullMd5} sysTextMd5=${sysTextMd5} msgsCount=${msgs.length} msgsAnchorIdx=${anchorIdx} msgsPrefixBytes=${msgsPrefixStr.length} msgsPrefixMd5=${msgsPrefixMd5}`,
      );
    } catch (e) {
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  return stageForwardWithRetry({
    target, upstreamHeaders, upstreamBody, originalBody, originalHeaders,
    pipe, forwardTimeoutMs, sessionKeyForDebug, rateLimitContext,
    protocol: "anthropic",
    timeoutBehavior: "always",
    buildRetryBody: (orig, _retryModel) => orig, // anthropic 不覆写 model
  });
}

/** Main handler for POST /v1/messages (Anthropic Messages API). */
export async function runAnthropicPipeline(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth (via shared stageAuth) ────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  // anthropic 客户端天然带 x-api-key, 用 bearer-or-xapi 模式保等价。
  const earlyAuth = await stageAuth(c, "xapi-first");
  const earlyApiKey = earlyAuth.apiKey;
  const earlySpaceId = earlyAuth.spaceId;
  const earlyVerify = { userId: earlyAuth.userId, rejected: earlyAuth.rejected, rejectReason: earlyAuth.rejectReason };
  if (earlyAuth.rejected) {
    return c.json({ type: "error", error: { type: "authentication_error", message: `Authentication failed: ${earlyAuth.rejectReason ?? "unknown"}` } }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  // Parse via shared stage (also PROXY_DEBUG_DUMP_INBOUND, dev-only)
  const parseResult = await stageParseBody(c);
  if (!parseResult.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // eslint-disable-next-line prefer-const
  let body = parseResult.body;

  // ── CC request classification (feature-gated, per-agent) ─────────────────
  // 通过 agentAdapter 分类请求 —— 每个客户端有自己的规则：
  //   - claude-code: 按 cache_control marker + tools/thinking 三分
  //   - codebuddy / unknown: 恒 main（未适配，等价现状）
  //
  // 关闭 ccRequestRouting.enabled 时强制视为 main，走完全等价现状的老链路。
  // 详见 docs/design/2026-07-30-cc-request-routing-plan.md
  const _pathPartsEarly = c.req.path.split("/").filter(Boolean);
  const _agentFromPathEarly = _pathPartsEarly[0]
    && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(_pathPartsEarly[0])
    ? _pathPartsEarly[0] : undefined;
  const _agentSourceEarly = _agentFromPathEarly ?? "claude-code";
  const agentAdapter = resolveAgentAdapter(_agentSourceEarly);
  // Resolve AgentStrategy early to gate downstream stages (identity, model gate,
  // opik, credit, rate-limit, telemetry). Default = full preset (100% behavior
  // preserved for CC/CB). Codex/WB opt-in gates per blueprint Phase 5.
  const _agentStrategy = resolveAgentStrategy(_agentSourceEarly);
  const _gates = _agentStrategy.stageGates;
  const ccRoutingEnabled = config.ccRequestRouting?.enabled === true;
  // adapter.classifyRequest 签名回 RequestKind (含 "auxiliary"), 但 CC 的 adapter
  // 只会返 main/fork/sidequery (anthropic 协议没有 /count_tokens 这类 aux 端点
  // 走到这里 —— aux 端点在 server.ts 分到 handleAuxiliaryEndpoint, 不进本 runner)。
  // 强转窄化 OK, 下游全部按 CcRequestKind 消费。
  const requestKind: CcRequestKind = (ccRoutingEnabled ? agentAdapter.classifyRequest(body) : "main") as CcRequestKind;
  // 遗留 `/proxy/<spaceId>` 前缀不带 agent 段，客户端身份无从判断；按错误的 agent
  // 画像弹表单、拦 mem 命令、注入资产比不做更糟，因此记忆类功能一律关闭。
  // 压缩、路由与计费不在这条门控下，照常生效。
  const legacyProxy = isLegacyProxyPath(c.req.path);
  /** 本轮是否允许触碰记忆：mem 命令、session-init、injection、L0、skill。 */
  const memoryTurn = requestKind === "main" && !legacyProxy;

  // ── Model gate: reject requests whose `model` is not a registered display name ──
  // 价目表已配置时，客户端 `model` 必须匹配某条 entry 的 `modelName`（展示名，
  // 大小写不敏感）。真实 model_id 是内部细节，不作为客户端入口。未匹配则直接
  // 400，避免请求转发成功却因无定价而漏计费。价目表为空时跳过（向后兼容）。
  //
  // 内部/外部用户一视同仁 —— internal callers must also request by
  // `modelName`, ensuring upstream ids and billing/observability keys align
  // across all traffic.
  const requestedModel = typeof body.model === "string" ? body.model : "unknown";

  // ── Early instance config fetch (needed before pricing gate) ──────────
  // Custom upstream (Option 2/3) may use models not in our pricing table,
  // and should NOT have their model alias-resolved to our internal IDs.
  //
  // The alias-skip gate depends on WHO is calling:
  //   - external caller → look at `type=conversation` (client's chat traffic)
  //   - systemUser (memory/knowledge/skill extraction) → look at
  //     `type=extraction` (client's memory-extraction upstream)
  // A conversation-typed row is unrelated to internal extraction traffic,
  // and vice versa. Prior code keyed off `conversation` unconditionally,
  // which regressed alias resolution for internal callers whenever the
  // instance carried any Option-2/3 conversation config.
  // ── Early instance upstream config (via shared stage, anthropic envelope) ──
  const earlyResult = await stageInstanceUpstreamEarly({
    c, config, spaceId: earlySpaceId, earlyUserId: earlyVerify.userId,
    errorEnvelope: "anthropic",
  });
  if (earlyResult.blockedResp) return earlyResult.blockedResp;
  const _earlyConvResolution = earlyResult.earlyConvResolution;
  const _earlyExtractRow = earlyResult.earlyExtractRow;
  const _earlySysMatch = earlyResult.earlySysMatch;
  const _isCustomUpstream = earlyResult.isCustomUpstream;

  // ── Model gate + alias (via shared stageModelGate, anthropic envelope) ──
  // modelGate 关闭 (codex/wb bootstrap 状态) → 跳过 400 gate 但仍执行 alias 解析,
  // 保证 upstream 收到规范 id;pricing 表未含时 modelId 回退 requestedModel。
  let modelId: string;
  let modelAliasApplied = false;
  if (_gates.modelGate) {
    const gateResult = stageModelGate(requestedModel, config, _isCustomUpstream);
    if (!gateResult.ok) {
      return c.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `Model '${requestedModel}' is not a registered display name in the credit pricing table`,
          },
        },
        400,
      );
    }
    modelId = gateResult.modelId;
    modelAliasApplied = gateResult.aliasApplied && typeof body.model === "string";
  } else {
    modelId = resolveModelId(config.creditPricing, requestedModel);
    modelAliasApplied = modelId !== requestedModel && typeof body.model === "string";
  }
  if (modelAliasApplied) body.model = modelId;

  // ── System-user short-circuit ────────────────────────────────────────────
  // Internal service accounts (see `systemUsers` config) bypass the entire
  // pipeline: no session-init, no injection, no routing. Matching key is
  // the userId resolved by verifyUserKey — NOT the raw apiKey. Auth-disabled
  // requests (userId == "") never match, so the short-circuit is inert unless
  // auth is on.
  //
  // We hand the already-parsed+alias-resolved `body` to the passthrough so
  // upstream sees the canonical model_id, aligning internal traffic with
  // external.
  if (_gates.systemUser) {
    const sysResp = await stageSystemUser(c, config, earlyVerify.userId, body);
    if (sysResp) return sysResp;
  }

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const isStream = body.stream === true;
  let hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/messages) ──
  const pathParts = c.req.path.split("/").filter(Boolean);
  const agentFromPath = pathParts[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(pathParts[0])
    ? pathParts[0] : undefined;
  const agentSource = agentFromPath ?? "claude-code";

  // ── Identity inspection ──────────────────────────────────────────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  if (_gates.identityRecord) {
    inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);
  }

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const apiKey = extractApiKey(c);
  let keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";

  // ── Lowercased headers for agent profile detection + session key ──────────
  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    lcHeaders[k.toLowerCase()] = v;
  }

// ── Session key: prefer conversation header, fallback to agent profile ───────────
  const { resolveConversationId } = await import("../../session/session-key.js");
  const conversationId = resolveConversationId(c);
  const sessionKey = conversationId ?? resolveSessionKey(config, lcHeaders, c.req.path, body, keyId);

  // ── Auth verification (user_key → user_id) ──────────────────────────────────────
  // Reuse the early verify result — it ran before body parse to decide the
  // system-user short-circuit; running verify again here would double the
  // network round-trip for every request.
  const spaceId = earlySpaceId;
  const userId = stageResolveUserId({ c, config, earlyVerifyUserId: earlyVerify.userId, logTag: "anthropicHandler" });
  if (userId) keyId = userId;

  // sk-mem key（用于 TDAI ACL / MetadataClient 的 x-tdai-user-key）就是入口的 apiKey。
  const callerUserKey = apiKey || null;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("../../injection/index.js");
    getInjectionPipeline(config);
  }

  // ── mem:session-reset pre-hook (via shared stage) ──
  // anthropic 用 memoryTurn 作 gate (requestKind=main && !legacyProxy).
  // header-only agent 拒绝分支 + 主 reset 流程都收敛在 stage 内部。
  // a08d67e9 dsh SSE tail fix 在 stage 内部的 header-only 拒绝响应处套 wrapper。
  const _resetResp = await stageSessionResetPreHook({
    c, config, body, agentSource, sessionKey, spaceId, userId,
    isAuxiliary: false, dshHeadless: false, isStream,
    protocol: "anthropic", enabled: memoryTurn,
  });
  if (_resetResp) return stageResponseTailFix(_resetResp, agentSource, isStream);

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("../../injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped}`);
  // CC 分流：SIDEQUERY 完全跳过 session-init（独立小请求无对话概念）。
  //          FORK 允许走 L2b recovery 复用 MAIN 已建的 session，但不进 form 交互路径
  //          （借用 MAIN 的 sessionInfo，见下方的 kind === 'fork' 分支保护）。
  const skipSessionInit = requestKind === "sidequery" || legacyProxy;
  if (config.sessionInit?.enabled && conversationId && !skipSessionInit) {
    try {
      // Round 18: session-init 主编排走 shared stageSessionInitOrchestrate;
      // anthropic 4 个 callback:
      //   - synthesizeMessages: body.messages 原样
      //   - buildRecoverInitResult: systemAppend + messages (anthropic system 分离)
      //   - buildInterceptResponse: 直接 initResult.response
      //   - forkPassthroughHook: requestKind === "fork" + recover 未命中 → passthrough (CC 独有)
      const compositeKey = `${agentSource}:${sessionKey}`;
      const _orch = await stageSessionInitOrchestrate({
        agentSourceForState: agentSource,
        sessionKey, userId: userId || null, spaceId,
        config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
        kernelUserKey: apiKey,
        headers: lcHeaders,
        recoveryMessages: (body.messages as Array<Record<string, unknown>>) ?? [],
        synthesizeMessages: () => (body.messages as Array<Record<string, unknown>>) ?? [],
        buildRecoverInitResult: async (recovered) => {
          const { buildSessionContextBlockWithToggles } = await import("../../session/context-injector.js");
          const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
          const systemAppend = recovered.bypassed
            ? null
            : buildSessionContextBlockWithToggles(
                recovered.agentDetail ?? null,
                recovered.taskDetail ?? null,
                config.sessionInit,
                sessionKey,
              );
          return { messages: inMsgs as Record<string, unknown>[], systemAppend };
        },
        buildReqCtx: () => ({
          stream: isStream, modelId: modelId as string, protocol: "anthropic",
        }),
        buildInterceptResponse: (initResult) => initResult.response ?? null,
        forkPassthroughHook: (recovered) => {
          // FORK L2b miss → passthrough. MAIN 未 init 时 fork 走 no-op, 让上游收原样。
          if (requestKind !== "fork") return null;
          if (recovered?.status === "initialized") return null;
          console.log(`[session-init:cc:fork] session=${compositeKey} L2b miss on fork request → passthrough`);
          return { intercepted: false, messages: body.messages as Record<string, unknown>[] };
        },
      });
      if (!_orch.proceed) return _orch.response!;
      const initResult = _orch.initResult!;
      const wentThroughSessionInitStateMachine = _orch.wentThroughStateMachine;

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${initResult.resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // sessionJustRegistered 用于 mem-command 的 checkFirst fallback（session init 最后
      // 一步"pending_task_select → initialized"那一 turn，把用户最开始的 mem: 命令补执行）。
      // **关键**：只在真正走 handleSessionInit state machine 的分支才继承 justRegistered；
      // L2b recovery 分支的 justRegistered=true 只是下游 prewarm 的重建信号，不是 session
      // init 过程，此时不设 sessionJustRegistered——否则 mem-command 会永久扒对话历史
      // 第一条 user，把用户最开始的 mem:help 当"未消化的命令"每 turn 重复执行。
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;
      // Bypass path → skip ALL injection hooks (via shared stageSessionBypass)
      // reset 流程中用户选了"跳过" → 也需要返回确认文案，不转发 LLM
      const _bypassResult = stageSessionBypass({
        bypassed: !!initResult.bypassed,
        resetFlow: !!initResult.resetFlow,
        sessionKey,
        logPrefix: "[session-init]",
      });
      if (_bypassResult.skipInjection) injectedSkipped = true;
      if (_bypassResult.resetFlowResult) _resetFlowResult = _bypassResult.resetFlowResult as unknown as typeof _resetFlowResult;

      assetCapabilities = await stageAssetCapabilities({
        bypassed: !!initResult.bypassed,
        sessionInfo: initResult.sessionInfo,
        config, spaceId,
        userKey: callerUserKey,
        warnPrefix: "[asset-capability] resolve failed:",
      });

      // Prewarm 前置短路：mem-command 命中的 turn 不 forward 上游、也不消费
      // hook-cache，若照常 prewarm 会白白多花 2-3s + 3 次网络请求。见 handler.ts
      // 对称位置详注。fork/sidequery 不做短路（requestKind === "main" 才生效）。
      let memCommandPending = false;
      if (memoryTurn) {
        try {
          const { parseMemCommand } = await import("../../mem-command/index.js");
          let peek = parseMemCommand(body as Record<string, unknown>, agentSource);
          if (!peek && sessionJustRegistered) {
            peek = parseMemCommand(body as Record<string, unknown>, agentSource, { checkFirst: true });
          }
          if (peek) {
            memCommandPending = true;
            console.log(`[hook-cache] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
          }
        } catch (err) {
          console.warn(
            "[mem-command] pre-prewarm peek failed (anthropic):",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Await prewarm so the first-turn pipeline always hits the cache.
      // A fire-and-forget void() here caused the bug where the pipeline
      // ran before the cache was populated, silently injecting zero
      // blocks for the entire first turn.
      // resetFlow=true 时必须 clearBefore:session-reset 切了 agent, 旧 agent 的
      // skill/wiki/knowledge 缓存要先清掉再写新的; 恒 clearBefore 统一语义更安全。
      await stagePrewarmInjection({
        bypassed: !!initResult.bypassed,
        justRegistered: !!initResult.justRegistered,
        sessionInfo: initResult.sessionInfo,
        agentDetail: initResult.agentDetail,
        taskDetail: initResult.taskDetail,
        memCommandPending,
        config, sessionKey, userId, agentSource, spaceId, assetCapabilities,
        callerUserKey: callerUserKey ?? undefined,
        logTag: "[hook-cache] handler prewarm error (anthropic):",
      });

      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      // Anthropic: apply the session-context block onto body.system. The init
      // module cannot see body.system (it's a handler-layer concern), so it
      // hands the pre-built block back through `systemAppend` and we merge it
      // here with the same append helper used by the direct-inject path.
      if (initResult.systemAppend) {
        const { appendBlockToAnthropicSystem } = await import("../../session/context-injector.js");
        body = { ...body, system: appendBlockToAnthropicSystem(body.system, initResult.systemAppend) };
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Legacy sessions persisted before space_id was tracked will hydrate
      // with an empty space_id. Restore it from the URL each request so
      // downstream skill / knowledge / injection paths route to the correct
      // kernel tenant instead of falling back to `context-proxy` (500).
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }

      // 记录 resetFlow 到外层供块外返回确认响应
      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "未知",
          // agentIdShort 字段名沿用历史，但此处**存完整 agent_id**（如 agt-1celthr7yn）。
          // 之前 slice(-8) 会截断成 "elthr7yn" 用户看不懂，与 team 截断问题对称。
          agentIdShort: initResult.sessionInfo?.agent_id
            ? String(initResult.sessionInfo?.agent_id) : "",
          // teamName + 完整 teamId：见 handler.ts 对称注释。
          teamName: initResult.teamName ?? undefined,
          teamId: initResult.sessionInfo?.team_id
            ? String(initResult.sessionInfo?.team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[session-init] Error in handleSessionInit (anthropic):", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // ── mem:session-reset 完成确认 ─────────────────────────────────────────────
  // session-reset 的交互流程：pre-hook 改 state → form 弹出 → 用户答完 form →
  // completeRegistration → prewarm → 到这里。此时用户的原始消息 "mem:session-reset"
  // 还在 body.messages 里,如果不拦截会被转发到 LLM,产生不可控输出。
  // 命令执行已经完成（新 agent 已绑定、缓存已刷新）→ 返回确认文案,不走 LLM。
  if (_resetFlowResult) {
    // a08d67e9 dsh SSE tail: mem-command 响应给 dsh 客户端需补 \n。
    // ⚠️ stageSessionResetConfirmation 是 async (返回 Promise<Response>),
    // 必须 await 后再传给同步的 stageResponseTailFix —— 否则 wrapper 首行
    // `!response.body` gate 会把 Promise 当成"无 body"直接透传,dsh v0.2+
    // 严格 SSE parser 收不到 `\n\n` 结尾 → STREAM_CLOSED。
    // 影响面:只有 dsh + 流式分支真正进 wrapper 补字节;其他 agentSource 全部
    // 在 wrapper 首行 `agentSource !== "dsh"` gate 原样 return,await 与否
    // 字节级一致。
    const _resetConfirmResp = await stageSessionResetConfirmation({
      resetFlowResult: _resetFlowResult,
      protocol: "anthropic",
      isStream,
      thinking: !!body?.thinking,
    });
    return stageResponseTailFix(_resetConfirmResp, agentSource, isStream);
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // 在 session init 完成后、injection pipeline 之前检测。
  // 命中时：执行命令 → 写 L0 → 触发 skill extract → 伪造响应返回。
  // 跳过注入（不破坏 KV cache）和上游转发（零 token 消耗）。
  // 命令拦截恒定启用，未知命令由 executeMemCommand 内的 KNOWN_COMMANDS 兜底提示。
  //
  // parseMemCommand 内部通过 agentAdapter.extractUserText 按客户端规则提取用户输入：
  //   - claude-code: 取最后一个 text block（跳过 <system-reminder> 前缀元数据）
  //   - codebuddy / unknown: 走保守的"拼接所有 text"逻辑
  //
  // CC 分流：FORK/SIDEQUERY 是 CC 客户端内部构造的请求，last_user 不会以 `mem:` 开头，
  //          且伪造响应会破坏 fork 请求依赖 MAIN 的 cache 假设。跳过拦截。
  // ── mem: command intercept (via shared stage) ──
  // a08d67e9 dsh SSE tail 修复: mem-command 命中时不管是错误响应还是成功响应,
  // dsh 客户端严格 parser 都需要末尾补 \n → 由 stage 返回后 wrapper 补一次。
  {
    const { extractSimpleMessages } = await import("../../mem-command/index.js");
    const memResp = await stageMemCommandIntercept({
      enabled: memoryTurn,
      body: body as Record<string, unknown>,
      agentSource, sessionKey,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      injectionSkipped: injectedSkipped,
      sessionJustRegistered,
      config, spaceId, userId, apiKey: apiKey || "",
      callerUserKey: callerUserKey ?? undefined,
      isStream, protocol: "anthropic",
      modelId: modelId as string,
      upstreamUrl: (agentFromPath ? config.upstream.agents?.[agentFromPath]?.url : undefined) ||
        config.upstream.url,
      messages: messages as unknown[],
      createTdaiClientFn: createTdaiClient,
      bodyMessages: extractSimpleMessages(body?.messages),
      assistantContentFormat: "anthropic-blocks",
      startTime, keyId, assetCapabilities,
      upstreamProtocol: "anthropic",
      thinking: !!body?.thinking,
    });
    if (memResp) return stageResponseTailFix(memResp, agentSource, isStream);
  }

  const tdaiClient = assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
        userKey: callerUserKey,
      });
  const tdaiUserMessage = extractLatestUserMessage(messages);

  // ── Context injection (via shared stage, before cost guard) ────────────
  // CC 分流:
  //   - SIDEQUERY: 完全跳过 (skip=true)
  //   - FORK:      readOnly=true (miss 时不 self-heal)
  //   - MAIN:      完整 pipeline
  const skipInjection = requestKind === "sidequery" || legacyProxy;
  if (skipInjection) {
    console.log(`[injection-debug] skipping injection for kind=sidequery session=${sessionKey}`);
  }
  {
    const injected = await stageInjectionRunner({
      skip: injectedSkipped || skipInjection,
      config, body, protocol: "anthropic", messages,
      traceId, keyId, modelId: modelId as string, isStream, agentSource,
      userId, spaceId, sessionKey, requestPath: c.req.path,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      assetCapabilities,
      callerUserKey: callerUserKey ?? undefined,
      readOnly: requestKind === "fork",
    });
    body = injected.body;
    messages = injected.messages;
    hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  }

  // ── Cost guard: resolve forward target (opaque — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name (URL path
  // prefix); both url and apiKey may be overridden per agent. When there's
  // no entry, we fall through to the Anthropic-specific global (costGuard
  // .anthropicUpstream) and finally to upstream.url — exactly as before.
  // ── Resolve forward target (via shared stage, anthropic protocol) ────
  const resolvedTarget = await stageResolveTargetFull({
    c, config, protocol: "anthropic", agentFromPath,
    keyId, sessionKey, messages, hasTools, body,
    modelId: modelId as string, headers: lcHeaders,
    traceId, startTime, spaceId,
  });
  const target = resolvedTarget.target;
  let effectiveApiKey = resolvedTarget.effectiveApiKey;
  const forwardEndpoint = resolvedTarget.forwardEndpoint;
  const costGuardMode = resolvedTarget.costGuardMode;

  // ── Instance upstream config override (via shared stage) ──────────────
  // b11bf612 GLM anthropic base_url /v1 auto-insert 修复走 joinUrl,已在
  // stageInstanceUpstreamOverride 内部替换手动拼接为 joinUrl(base, c.req.path)。
  const overrideResult = stageInstanceUpstreamOverride({
    earlyConvResolution: _earlyConvResolution,
    target, forwardEndpoint, apiKey, body, modelId,
    requestPath: c.req.path,
  });
  if (overrideResult.applied) {
    target.url = overrideResult.newTargetUrl;
    effectiveApiKey = overrideResult.newEffectiveApiKey;
    if (overrideResult.bodyModelUpdated) {
      body.model = overrideResult.newModelId;
      modelId = overrideResult.newModelId;
    }
  }
  const skipCreditReport = overrideResult.skipCreditReport;

  // ── Create pipeline logger ──────────────────────────────────────────────
  const pipe = createPipeline(config, traceId, target.model);
  pipe.requestReceived(messages.length, isStream);
  if (target.logLine) pipe.info("COST_GUARD", target.logLine);
  if (target.logLineExtra) pipe.info("COST_GUARD_DETAIL", target.logLineExtra);
  if (ccRoutingEnabled) {
    console.log(`[cc-routing] session=${sessionKey} kind=${requestKind} msgs=${messages.length}`);
  }



  // ── Trace-level tags ──
  // agent_source 标明客户端族群（codebuddy / claude-code / codex / …），供
  // Langfuse 上按客户端筛选 trace；protocol 只区分 wire 协议，同一 wire
  // 可对应多个客户端。
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:anthropic",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked
  // (extension disabled/unavailable, or no-tools auxiliary request).
  // Both sources drop back to 1 when their state is lost (truncated history /
  // expired counter), colliding with the usage rows this session already wrote
  // — Redis, when enabled, turns them into a per-session sequence that only
  // ever moves forward. sidequery/fork share the sessionKey but carry a much
  // shorter history, so each kind counts on its own lane.
  // ── Turn context 装配 via shared stageBuildLangfuseTurnContext ──
  // lane=requestKind: main/fork/sidequery 各自独立 turnSeq 车道。
  const { turnSeq, lf } = await stageBuildLangfuseTurnContext({
    config, sessionKey, keyId, target, messages, protocol: "anthropic",
    traceTags, path: c.req.path, headers: lcHeaders, body, lane: requestKind,
  });
  stageReportAnalyzerTrace({ config, target, traceId, lf, keyId, sessionKey, turnSeq, startTime, spaceId });

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // 抓 CB / CC 客户端指纹用；关闭时恒返回 {}，不污染线上 metadata。
  // 详见 common/langfuse-debug.ts。
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    requestKind,
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "anthropic",
  });

  // ── Opik: create trace ───────────────────────────────────────────────────
  const forkTraceId = _gates.opik ? opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenAnthropicMessagesForOpik(messages, body.system) },
    tags: [...traceTags, ...target.tags],
    forkProjectName: "request_log",
    forkMetadata: {
      keyId,
      modelId: target.model,
      stream: isStream,
      upstreamUrl: target.url,
    },
  }) : undefined;

  // ── Request debug log ────────────────────────────────────────────────────
  writeRequestLog(config, body);

  // ── Build upstream request ───────────────────────────────────────────────
  // Per-agent apiKey resolution — three cases:
  //   (a) no entry in agents map           → global upstream.apiKey (兜底)
  //   (b) entry present, apiKey empty      → "" (passthrough, keep client key)
  //   (c) entry present, apiKey non-empty  → agent.apiKey (server-side key)
  // The presence of an entry (case b/c) is what cuts the global fallback —
  // effectiveApiKey already resolved above (before instance config override).
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "anthropic",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      system: body.system,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
    opikTraceId: traceId,
    opikKeyId: keyId,
    skipPrepare: costGuardMode === "cheap",
  });

  const { body: upstreamBody, sanitizedCount } = buildUpstreamBody(body, target);
  if (sanitizedCount > 0) {
    pipe.info(
      "FORWARD",
      `stripped ${sanitizedCount} invalid thinking block(s) from history`,
    );
  }

  // Retry headers: preserve original client headers (x-request-id, user-agent,
  // etc.), then force the primary upstream's auth — retry always goes to the
  // default upstream (never the alternate route), so its apiKey must be applied
  // just like the first-attempt path. Without this, retry sends the
  // client's raw auth to tokenhub and gets 401.
  const originalHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      originalHeaders[k] = v;
    }
  }
  // Retry uses the same effective key as the primary path — same three
  // cases as above. When it resolves to "" (agent entry present but no
  // apiKey), retry also runs on the client's own key: preserves the
  // "passthrough on this agent" intent even across retries.
  if (effectiveApiKey) {
    originalHeaders["x-api-key"] = effectiveApiKey;
    delete originalHeaders["authorization"];
  }

  const retryBody = sanitizeThinkingBlocks(body).body;

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  // forwardTimeout gate 关 (codex/wb bootstrap) → 传 0,anthropic timeoutBehavior='always' 分支
  // 会用 0 作为 AbortSignal.timeout,行为 = 立即 abort;所以关闭仅在 caller 明确要"永不超时"时用。
  // 目前 anthropic runner 只服务 CC (full preset gates.forwardTimeout=true),不会踩到 0-timeout。
  const forwardTimeoutMs = _gates.forwardTimeout ? (config.server.forwardTimeoutMs ?? 600_000) : 0;
  // 传 target.url:override 生效时(instance-upstream custom 组)与 cost-guard 便宜模型路由
  // 都会改 target.url,不传参会 fallback 到 config.upstream.url 打错日志(实际 fetch 用 target.url,
  // 但 log 上会误导排障)。handler.ts 已对这么做,anthropicHandler 之前漏了。
  pipe.forwardStart(target.url);
  let upstreamResp: Response;
  let retried = false;

  try {
    // Rate limit 只对官方模型生效:custom upstream 用的是用户自己的 base_url + api_key,
    // 上游 quota 由用户自己管;proxy 的 QPM/TPM 桶是运营方按自家上游算的,套到 custom
    // 上等于错杀。传 undefined → forwardWithRetry 内 `if (rateLimitContext)` 自然跳过。
    // rateLimit gate 关闭时(codex/wb bootstrap)同样跳过。
    const rateLimitContext = (_isCustomUpstream || !_gates.rateLimit) ? undefined : { config, instanceId: spaceId || undefined };
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      retryBody, originalHeaders,
      pipe, forwardTimeoutMs,
      sessionKey,
      rateLimitContext,
    );
    upstreamResp = result.resp;
    retried = result.retried;
  } catch (err: unknown) {
    if (isRateLimitExceededError(err)) {
      pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
      return err.response;
    }
    langfuseReportFailure({
      lf,
      model: target.model,
      startTime,
      endTime: new Date().toISOString(),
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers — via shared filterResponseHeaders
  const respHeaders = filterResponseHeaders(upstreamResp.headers);

  // Upstream request id from response header (tokenhub / Anthropic set
  // `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response (Anthropic SSE) ──────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log error body for 4xx
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errStream, clientStream] = upstreamResp.body.tee();
      const errText = await new Response(errStream).text();
      pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${errText.slice(0, 1000)}`);
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId: target.model,
        keyId,
        sessionKey,
        upstreamUrl: target.url,
        stream: true,
        usage: { error: true, status: upstreamResp.status, body: errText.slice(0, 500) },
        ...responseLogMeta,
        routedFrom,
        spaceId,
        upstreamRequestId,
      });
      langfuseReportFailure({
        lf,
        model: effectiveModel,
        startTime,
        endTime: new Date().toISOString(),
        input: buildLangfuseInput(messages, body.system, langfuseDebug),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
    }

    const [rawClientStream, tapStream] = upstreamResp.body.tee();
    pipe.streamStart();

    // Background: consume tap stream for Anthropic SSE → extract usage
    consumeAnthropicStream(tapStream, {
      config,
      modelId: effectiveModel,
      keyId,
      sessionKey,
      upstreamUrl: target.url,
      requestPath: c.req.path,
      traceId,
      forkTraceId,
      startTime,
      inputMessages: messages,
      system: body.system,
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      sessionInfo,
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      lf,
      spaceId,
      upstreamRequestId,
      requestKind,
      langfuseDebug,
      debugMetadata,
      preparedStats,
      skipCreditReport,
      isCustomUpstream: _isCustomUpstream,
      gates: _gates,
    });

    // CFQ 剥离排在最后：tap 走的是另一条 tee 分支，读到的仍是模型原始输出。
    const clientStream = rawClientStream
      .pipeThrough(createSseThinkingFixStream(pipe))
      .pipeThrough(createCfqStripStream(
        "anthropic",
        preparedStats,
        createCfqStripObserver(pipe),
      ));

    return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  let respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const content = respJson.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      let thinkingPatched = false;
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text") textParts.push(block.text as string);
        // Fix thinking blocks with missing/null `thinking` field.
        // Some models (e.g. DeepSeek) emit `type: "thinking"` blocks
        // without a valid `thinking` string, causing Claude Code to crash
        // with "undefined is not an object (evaluating 's.thinking.length')".
        if (block.type === "thinking") {
          if (block.thinking === undefined || block.thinking === null) {
            block.thinking = "";
            thinkingPatched = true;
          } else if (typeof block.thinking !== "string") {
            block.thinking = String(block.thinking);
            thinkingPatched = true;
          }
        }
      }
      if (thinkingPatched) {
        respText = JSON.stringify(respJson);
        pipe.info("NONSTREAM_THINKING_FIX", "patched thinking block(s) with missing 'thinking' field");
      }
      outputContent = textParts.join("\n");
      // Preserve full content array (incl. tool_use blocks) for skill trigger.
      assistantMessage = { role: "assistant", content };

      // Report the completed response to the extension (same signal the
      // streaming path emits). Fire-and-forget.
      void notifyUpstreamResponse(
        config,
        {
          protocol: "anthropic",
          sessionKey,
          model: effectiveModel,
          stream: false,
          turnSeq: lf.turnSeq,
          text: outputContent,
          toolCalls: (content as Record<string, unknown>[])
            .filter((b) => b?.type === "tool_use")
            .map((b) => ({
              id: (b.id as string) ?? "",
              name: (b.name as string) ?? "",
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input ?? ""),
            }))
            .filter((tc) => tc.id && tc.arguments),
          usage: usage ?? {},
        },
        pipe,
      );

      // 内部使用埋点：非流式响应 tool_use 块逐个记 model_intent。
      try {
        const intents = (content as Record<string, unknown>[])
          .filter((b) => b?.type === "tool_use")
          .map((b) => {
            const name = (b.name as string) ?? "";
            const input = b.input;
            const argsStr = typeof input === "string" ? input : JSON.stringify(input ?? "");
            return { name, arguments: argsStr };
          })
          .filter((i) => i.name);
        if (intents.length > 0 && _gates.modelIntentTelemetry) {
          emitModelIntentTelemetry({
            // 与 session_init_logs 对齐 compositeKey 形态
            sessionKey: `${agentSource}:${sessionKey}`,
            turnSeq: lf.turnSeq,
            spaceId,
            userId: keyId,
            agentSource,
            intents,
          });
        }
      } catch {
        // 埋点绝不阻塞业务
      }
    }
  } catch {
    // non-JSON response
  }

  const logMeta = responseLogMeta;

  if (usage) {
    // custom upstream 不记 token 桶(与 enforceRateLimit 对称:官方限流桶只算官方调用)
    // rateLimit gate 关闭时同步跳过 token 记账
    if (!_isCustomUpstream && _gates.rateLimit) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId: effectiveModel,
        usage,
        protocol: "anthropic",
      });
    }
    if (_gates.writeLogUsage) {
      writeLog(config, {
        timestamp: endTime,
        event: "usage",
        modelId: effectiveModel,
        keyId,
        sessionKey,
        turnSeq: lf.turnSeq,
        userInput: lf.userQuery || undefined,
        upstreamUrl: target.url,
        stream: false,
        usage,
        requestReceivedAt: startTime,
        extensionStats: preparedStats ?? undefined,
        ...logMeta,
        routedFrom,
        spaceId,
        upstreamRequestId,
      });
    }

    if (_gates.opik) {
      opikCreateLlmSpan(config, {
        traceId,
        projectName: keyId,
        name: effectiveModel,
        startTime,
        endTime,
        inputMessages: flattenAnthropicMessagesForOpik(messages, body.system),
        outputMessage: outputContent ? { role: "assistant", content: outputContent } : null,
        model: effectiveModel,
        usage,
        tags: retried ? ["retry"] : undefined,
        forkProjectName: "request_log",
        forkTraceId,
        forkMetadata: {
          keyId,
          modelId: effectiveModel,
          stream: false,
          upstreamUrl: target.url,
        },
      });
    }

    // Langfuse: report this LLM call as a generation under the turn trace
    // debug=true 时 output 用 assistantMessage 原生数组（含 tool_use / thinking /
    // 原生 stop_reason），非 debug 走原有 text 拼接节省存储。
    const langfuseOutput = langfuseDebug && assistantMessage
      ? assistantMessage
      : outputContent
      ? { role: "assistant", content: outputContent }
      : undefined;
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      output: langfuseOutput,
      usage,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: langfuseOutput,
      traceMetadata: { stream: false, retried, upstreamUrl: target.url, ...logMeta, ...debugMetadata },
      observationMetadata: { retried, ...logMeta, ...debugMetadata },
    });
  } else if (upstreamResp.status >= 400) {
    pipe.error("UPSTREAM_4xx", `status=${upstreamResp.status} body=${respText.slice(0, 1000)}`);
    langfuseReportFailure({
      lf,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInput(messages, body.system, langfuseDebug),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // CC 分流：FORK/SIDEQUERY 是 CC 客户端后台自发调用，不是用户真实对话轮，
  //          跳过 skill/L0 副作用。Credit 仍上报（token 消耗真实）。
  const isMainDialog = memoryTurn;

  // Skill extract trigger — count tool_use blocks + buffer conversation.
  // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
  if (isMainDialog && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "anthropic",
      assetCapabilities,
    });
  } else if (isMainDialog) {
    logExtractionSkipped(config, "skill", sessionKey);
  } else {
    console.log(`[cc-routing] skip skill buffer for kind=${requestKind} session=${sessionKey}`);
  }

  // TDAI L0 write (non-streaming).
  //
  // 与 stream 分支 (1476-1481) 对称：把 user_query + assistant 回复写入 L0
  // 短期记忆。**此前仅 stream=true 会写**，non-stream 请求（如工具/测试脚本
  // 常用的 stream:false）沉默丢失。缺失该调用意味着 CC non-stream 场景
  // 完全没有 L0 记忆写入。
  if (isMainDialog && tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
    recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, outputContent)
      .catch((err: unknown) => pipe.error("TDAI_L0", err));
  } else if (isMainDialog && tdaiClient) {
    logExtractionSkipped(config, "tdai-memory", sessionKey);
  } else if (!isMainDialog) {
    console.log(`[cc-routing] skip L0 write for kind=${requestKind} session=${sessionKey}`);
  }

  // Credit usage reporting (non-streaming) via shared stageCredit.
  if (_gates.creditReport) {
    const creditResult = await stageCredit({
      skipCreditReport,
      config,
      path: c.req.path,
      usage,
      effectiveModel,
      upstreamUrl: target.url,
      event: "usage",
      startTime: new Date(startTime),
      reqIds: pipe.ids(),
      upstreamRequestId,
      sessionKey,
      stream: false,
      keyId,
      routedFrom,
    }, pipe);
    if (creditResult.responseErrorHeader) {
      respHeaders.set("x-credit-report-error", creditResult.responseErrorHeader);
    }
  }

  // 最后一公里：notify / 日志 / 计费都已经看过原始响应，这里才动给客户端的那份。
  const clientRespText = stripCfqFromResponseText(
    "anthropic",
    respText,
    preparedStats,
    createCfqStripObserver(pipe),
  );
  return new Response(clientRespText, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}


/**
 * Create a TransformStream that patches Anthropic SSE events in-band.
 */
function createSseThinkingFixStream(
  pipe: ReturnType<typeof createPipeline>,
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let patchedCount = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sseBuf += decoder.decode(chunk, { stream: true });

      const parts = sseBuf.split("\n\n");
      sseBuf = parts.pop() ?? "";

      for (const part of parts) {
        const lines = part.split("\n");
        let dataLine = "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataLine = line;
          }
        }

        if (!dataLine) {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        const dataStr = dataLine.slice(6);
        if (!dataStr || dataStr === "[DONE]") {
          controller.enqueue(encoder.encode(part + "\n\n"));
          continue;
        }

        try {
          const evt = JSON.parse(dataStr) as Record<string, unknown>;
          let patched = false;

          if (evt.type === "content_block_start") {
            const block = evt.content_block as Record<string, unknown> | undefined;
            if (block?.type === "thinking") {
              if (block.thinking === undefined || block.thinking === null) {
                block.thinking = "";
                patched = true;
              } else if (typeof block.thinking !== "string") {
                block.thinking = String(block.thinking);
                patched = true;
              }
            }
          }

          // Fix content_block_delta with type=thinking_delta but missing thinking field.
          // Claude Code does `contentBlock.thinking += delta.thinking` which would
          // produce "null" or "undefined" strings if delta.thinking is not a string.
          if (evt.type === "content_block_delta") {
            const delta = evt.delta as Record<string, unknown> | undefined;
            if (delta?.type === "thinking_delta") {
              if (delta.thinking === undefined || delta.thinking === null) {
                delta.thinking = "";
                patched = true;
              } else if (typeof delta.thinking !== "string") {
                delta.thinking = String(delta.thinking);
                patched = true;
              }
            }
          }

          if (patched) {
            patchedCount++;
            const newDataLine = "data: " + JSON.stringify(evt);
            const newLines = lines.map((l) =>
              l.startsWith("data: ") ? newDataLine : l,
            );
            controller.enqueue(encoder.encode(newLines.join("\n") + "\n\n"));
          } else {
            controller.enqueue(encoder.encode(part + "\n\n"));
          }
        } catch {
          controller.enqueue(encoder.encode(part + "\n\n"));
        }
      }
    },

    flush(controller) {
      if (sseBuf.trim()) {
        controller.enqueue(encoder.encode(sseBuf));
      }
      if (patchedCount > 0) {
        pipe.info("SSE_FIX", `patched ${patchedCount} thinking block(s) with missing 'thinking' field`);
      }
    },
  });
}

// ── Stream processing helpers ────────────────────────────────────────────────

interface AnthropicTapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  requestPath: string;
  traceId: string;
  /** Undefined when opik gate is off (no fork trace created). */
  forkTraceId?: string;
  startTime: string;
  inputMessages: unknown[];
  /** Anthropic top-level `system` field (string or content-block array). */
  system: unknown;
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger. */
  sessionKeyForSkill: string;
  /** Client type (URL path 第一段) — 透传给 extract trigger 作为三段隔离键之一。 */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Tdai L0 write. */
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** CC 请求分流类别，决定 stream 完成后是否触发 skill/L0 副作用。 */
  requestKind: CcRequestKind;
  /** `config.langfuse.debug === true` 的求值结果，透传避免流内重复读 config。 */
  langfuseDebug: boolean;
  /** buildRequestDebugMetadata 求值结果；debug=false 时为 {}。 */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
  /** Instance upstream config: skip credit reporting for custom model. */
  skipCreditReport?: boolean;
  /** true when the request is routed to a custom upstream (user's own base_url + api_key). */
  isCustomUpstream?: boolean;
  /** Stage-level gates from the resolved AgentStrategy. `undefined` = 100% CC behavior preserved. */
  gates?: import("../strategies/agent/types.js").StageGates;
}

/**
 * Consume Anthropic SSE stream in background, extract usage, log + Opik.
 */
function consumeAnthropicStream(stream: ReadableStream<Uint8Array>, ctx: AnthropicTapContext): void {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, system, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let streamCompleted = false;
    // 内部使用埋点用：按 index 累积每个 tool_use 块。
    // Anthropic SSE 协议：
    //   1. content_block_start(type=tool_use)  → 拿到 index + name（此时 input 是空 {}）
    //   2. content_block_delta(type=input_json_delta) → 累积 partial_json 字符串
    //   3. content_block_stop → 该块结束
    // 之前的实现只读了 (1) 里的 input（永远空）—— 现在按 index 累加 (2) 里的 partial_json。
    const toolUseAcc = new Map<number, { id: string; name: string; inputJson: string }>();

    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Anthropic stream reading exceeded 5 minutes");
        // completeStream 是 async；这里 fire-and-forget（timeout 里已经无法 await）
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();

      if (Object.keys(usage).length > 0) {
        await stageRecordTokenUsage({
          config, gates: ctx.gates,
          isCustomUpstream: !!ctx.isCustomUpstream,
          spaceId, modelId, usage, protocol: "anthropic",
        });
        stageWriteUsageLog({
          config, gates: ctx.gates, pipe,
          timestamp: endTime, modelId, keyId, sessionKey,
          turnSeq: lf.turnSeq, userInput: lf.userQuery || undefined,
          upstreamUrl, usage, requestReceivedAt: startTime,
          extensionStats: ctx.preparedStats ?? undefined,
          logMeta, routedFrom: ctx.routedFrom, spaceId, upstreamRequestId,
        });
        stageOpikStreamSpan({
          config, gates: ctx.gates, pipe,
          traceId, forkTraceId, keyId, modelId, startTime, endTime,
          inputMessages: flattenAnthropicMessagesForOpik(inputMessages, system),
          outputMessage: outputText ? { role: "assistant", content: outputText } : null,
          usage, retried, upstreamUrl,
          // anthropic 老行为: 只 create span, 不 updateTrace, 无 "stream" tag
        });

        // Langfuse: report this LLM call as a generation under the turn trace
        // 流式无完整原生 assistant content 数组可用（tool_use 块在 SSE 里是分片
        // 增量事件），debug 时把 tool_use_count 与 stop_reason 塞进 metadata 兜底。
        try {
          const streamDebugExtra = ctx.langfuseDebug
            ? {
                stream_tool_use_count: toolUseCount,
                stream_output_text_len: outputText.length,
              }
            : {};
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildLangfuseInput(inputMessages, system, ctx.langfuseDebug),
            output: outputText ? { role: "assistant", content: outputText } : undefined,
            usage,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: outputText ? { role: "assistant", content: outputText } : undefined,
            traceMetadata: {
              stream: true, retried, upstreamUrl, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
            observationMetadata: {
              retried, ...logMeta,
              ...ctx.debugMetadata, ...streamDebugExtra,
            },
          });
        } catch (langfuseErr: unknown) {
          pipe.error("LANGFUSE_SPAN", langfuseErr);
        }
      }

      // CC 分流：FORK/SIDEQUERY 不是真实对话轮，跳过 L0/skill。Credit 仍上报。
      const isMainDialog = ctx.requestKind === "main";

      // Tdai L0 write
      if (isMainDialog && ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
        // Streaming 不 await（会拖慢 SSE 关流），trackWrite + withL0Retry 应对两条丢包线：
        //   - trackWrite 注册 in-flight promise 到全局 set；SIGTERM 时 index.ts 会
        //     flushPendingWrites 兜底，避免 pod rolling 时 event loop 未 flush 就退出丢 L0。
        //   - withL0Retry 3 次退避重试（~3.5s），挡 tdai kernel 瞬断 / 5xx / 网络抖动。
        trackWrite(
          withL0Retry(() => recordTdaiTurn(
            ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
            outputText || null,
          )).catch((err: unknown) => pipe.error("TDAI_L0", err))
        );
      } else if (isMainDialog && ctx.tdaiClient) {
        logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
      } else if (!isMainDialog) {
        console.log(`[cc-routing] skip L0 write (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      pipe.streamDone(Object.keys(usage).length > 0 ? usage : null);

      // Report the completed response to the extension. Fire-and-forget; the
      // client has already been served by this point.
      void notifyUpstreamResponse(
        ctx.config,
        {
          protocol: "anthropic",
          sessionKey: ctx.sessionKey ?? "",
          model: modelId,
          stream: true,
          turnSeq: lf.turnSeq,
          text: outputText,
          toolCalls: Array.from(toolUseAcc.values())
            .filter((v) => v.id && v.inputJson)
            .map((v) => ({ id: v.id, name: v.name, arguments: v.inputJson })),
          usage,
        },
        pipe,
      );

      // 内部使用埋点：SSE 流累积的 tool_use 各出一条 model_intent。
      // 详见 docs/design/2026-08-03-internal-usage-telemetry-plan.md §7.2 F。
      // session_key 必须与 session_init_logs 用同一份 compositeKey (agentSource:sessionKey)，
      // 否则 §4.1 CTE 里的 `session_key IN (init_sessions)` 会对不上。
      // 按 index 排序输出（还原模型生成顺序）；inputJson 是流式累积的 partial_json
      stageEmitModelIntent({
        gates: ctx.gates,
        sessionKey: `${ctx.agentSource}:${ctx.sessionKey}`,
        turnSeq: ctx.lf.turnSeq,
        spaceId: ctx.spaceId,
        userId: ctx.keyId,
        agentSource: ctx.agentSource,
        intents: Array.from(toolUseAcc.entries())
          .sort(([a], [b]) => a - b)
          .filter(([, v]) => v.name)
          .map(([, v]) => ({ name: v.name, arguments: v.inputJson || "{}" })),
      });

      // Skill extract trigger — after stream finalization.
      // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
      if (isMainDialog && isExtractionAllowed(ctx.config, "skill")) {
        await triggerSkillExtractIfReady({
          config: ctx.config,
          sessionKey: ctx.sessionKeyForSkill,
          agentSource: ctx.agentSource,
          sessionInfo: ctx.sessionInfo,
          inputMessages: ctx.inputMessages,
          assistantMessage: outputText
            ? { role: "assistant", content: outputText }
            : null,
          protocol: "anthropic",
          assetCapabilities: ctx.assetCapabilities,
          toolCallCountOverride: toolUseCount,
        });
      } else if (isMainDialog) {
        logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
      } else {
        console.log(`[cc-routing] skip skill buffer (stream) for kind=${ctx.requestKind} session=${ctx.sessionKeyForSkill}`);
      }

      // Credit usage reporting (streaming) via shared stageCredit.
      if (ctx.gates?.creditReport !== false) {
        stageCredit({
          skipCreditReport: ctx.skipCreditReport,
          config: ctx.config,
          path: ctx.requestPath,
          usage,
          effectiveModel: ctx.modelId,
          upstreamUrl: ctx.upstreamUrl,
          event: "usage",
          startTime: new Date(ctx.startTime),
          reqIds: pipe.ids(),
          upstreamRequestId: ctx.upstreamRequestId,
          sessionKey: ctx.sessionKey ?? "",
          stream: true,
          keyId: ctx.keyId,
          routedFrom: ctx.routedFrom,
        }, pipe).catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
      }
    }

    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });

        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";

        for (const part of parts) {
          const lines = part.split("\n");
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              dataStr = line.slice(6);
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5);
            }
          }

          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string;

            if (evtType === "message_start") {
              const message = evt.message as Record<string, unknown> | undefined;
              if (message?.usage) {
                Object.assign(usage, message.usage as Record<string, unknown>);
              }
            } else if (evtType === "message_delta") {
              if (evt.usage) {
                Object.assign(usage, evt.usage as Record<string, unknown>);
              }
            } else if (evtType === "content_block_delta") {
              const delta = evt.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                outputText += delta.text;
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                // 累积到对应 tool_use 块（按 index）
                try {
                  const idx = evt.index as number | undefined;
                  if (typeof idx === "number") {
                    const acc = toolUseAcc.get(idx);
                    if (acc) acc.inputJson += delta.partial_json;
                  }
                } catch {
                  // ignore — 埋点级别的问题不阻塞主链路
                }
              }
            } else if (evtType === "content_block_start") {
              const block = evt.content_block as Record<string, unknown> | undefined;
              if (block?.type === "tool_use") {
                toolUseCount++;
                try {
                  const name = (block.name as string) ?? "";
                  const idx = evt.index as number | undefined;
                  if (name && typeof idx === "number") {
                    toolUseAcc.set(idx, { id: (block.id as string) ?? "", name, inputJson: "" });
                  }
                } catch {
                  // ignore — 累积失败不影响主链路
                }
              }
            }
          } catch {
            // ignore malformed SSE data
          }
        }
      }

      // Drain remaining buffer
      if (sseBuf.trim()) {
        const lines = sseBuf.split("\n");
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataStr = line.slice(6);
          }
        }
        if (dataStr && dataStr !== "[DONE]") {
          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            if (evt.type === "message_delta" && evt.usage) {
              Object.assign(usage, evt.usage as Record<string, unknown>);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("STREAM", err);
    }

    await completeStream();
  })().catch((err: unknown) => {
    pipe.error("STREAM_CONSUME", err);
  });
}
