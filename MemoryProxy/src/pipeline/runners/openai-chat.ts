/** Core request handler: intercept → forward → parse usage → log. */

import type { Context } from "hono";
import { createHash } from "node:crypto";
import { writeLog, createPipeline } from "../../logger.js";
import {
  apiKeyToKeyId,
  extractBearerToken,
  opikCreateLlmSpan,
  opikCreateTrace,
  opikUpdateTrace,
  uuidv7,
} from "../../opik.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import {
  buildLangfuseInputChat,
  buildRequestDebugMetadata,
} from "../../common/langfuse-debug.js";
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
import { stageModelGate, buildUnregisteredModelErrorBody } from "../stages/model-gate.js";
import { stageCredit } from "../stages/credit.js";
import { stageSystemUser } from "../stages/system-user.js";
import { stageBuildLangfuseTurnContext, stageReportAnalyzerTrace } from "../stages/observability.js";
import { stageSessionResetPreHook } from "../stages/session-reset-pre-hook.js";
import { stageSessionResetConfirmation } from "../stages/session-reset-confirmation.js";
import { stageMemCommandIntercept } from "../stages/mem-command-intercept.js";
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
import { stageInjectionRunner } from "../stages/injection-runner.js";
import { stageInstanceUpstreamEarly } from "../stages/instance-upstream-early.js";
import { stageInstanceUpstreamOverride } from "../stages/instance-upstream-override.js";
import { stageResolveTargetFull } from "../stages/resolve-target-full.js";
import { stageResolveUserId } from "../stages/resolve-user-id.js";
import { stageForwardWithRetry } from "../stages/forward-with-retry.js";
import { resolveAgentStrategy } from "../strategies/agent/index.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import { handleSystemUserPassthrough } from "../../systemUserPassthrough.js";
import { TdaiClient, buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import { extractLatestUserMessage, recordTdaiTurn } from "../../tdai/recorder.js";
import { opencodeAdapter } from "../../agent-adapters/opencode.js";
import { trackWrite, withL0Retry } from "../../tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { triggerSkillExtractIfReady } from "../../skill/handler-glue.js";
import { emitModelIntentTelemetry } from "../../session/model-intent-telemetry.js";
import { isExtractionAllowed, logExtractionSkipped } from "../../extraction-gate.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "../../rate-limit/guard.js";

/**
 * Build a per-request TdaiClient. `spaceId` (extracted from the request path
 * `/{agent}/{spaceId}/...`) overrides `config.tdai.serviceId` so writes/recalls
 * land on the correct kernel tenant. Falls back to config when the request
 * carries no spaceId (older single-tenant deployments).
 */
// TDAI client factory 已合并到 tdai/client.ts::buildTdaiClientForRequest
const createTdaiClient = buildTdaiClientForRequest;

/**
 * Flatten messages into Opik-friendly chat messages (no truncation).
 */
export function flattenMessagesForOpik(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const role = m.role as string;
    const content = m.content;

    if (typeof content === "string") {
      result.push(msg);
      continue;
    }

    if (!Array.isArray(content)) {
      if (role === "assistant" && Array.isArray(m.tool_calls)) {
        if (typeof content === "string" && content) {
          result.push({ role: "assistant", content });
        }
        for (const tc of m.tool_calls as unknown[]) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
        continue;
      }
      result.push(msg);
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
          textParts.push(`[thinking] ${b.thinking as string}`);
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
      const topLevelToolCalls = m.tool_calls;
      if (Array.isArray(topLevelToolCalls)) {
        for (const tc of topLevelToolCalls) {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          let argsStr = "";
          if (fn?.arguments) {
            argsStr = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments);
          }
          result.push({
            role: "assistant",
            content: JSON.stringify({ tool_call_id: t.id, tool_name: fn?.name ?? "unknown", arguments: argsStr }, null, 2),
          });
        }
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

// SKIP header sets 已合并到 common/constants.ts
// handler.ts 老行为: HOP_BY_HOP 4 项 (不含 x-tdai-user-key 泄漏保护) —
// 保留兼容, 未来可升级到 WITH_INTERNAL 版本。
import { SKIP_REQUEST_HEADERS_HOP_BY_HOP as SKIP_REQUEST_HEADERS, filterResponseHeaders } from "../../common/constants.js";

/** Extract usage object from a block of OpenAI SSE text. */
export function extractSseUsage(sseText: string): Record<string, unknown> | null {
  let lastUsage: Record<string, unknown> | null = null;

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;

    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      if (evt.usage && typeof evt.usage === "object") {
        lastUsage = evt.usage as Record<string, unknown>;
      }
    } catch {
      // ignore malformed SSE lines
    }
  }

  return lastUsage;
}

/**
 * Build upstream body from original body + cost guard overrides.
 * The host does NOT branch on routing — it just applies overrides if present.
 */
function buildUpstreamBody(
  body: Record<string, unknown>,
  target: ForwardTarget,
): Record<string, unknown> {
  let upstreamBody = body;
  if (target.bodyOverrides) {
    upstreamBody = { ...body, ...target.bodyOverrides };
  }
  return upstreamBody;
}

/**
 * Build upstream headers from request headers + routing auth overrides.
 * If config.upstream.apiKey is set, it overrides the request's Authorization header
 * only for the default route (not alternate model route).
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

  // `effectiveApiKey` is pre-resolved by the caller — see the resolveEffective
  // block near the call site. Non-empty → inject as server-side Bearer;
  // empty/undefined → passthrough (client's own Authorization survives).
  // cost-guard's `target.authHeaders` still gets to override everything.
  if (effectiveApiKey && !target.authHeaders) {
    headers["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  if (target.authHeaders) {
    for (const [k, v] of Object.entries(target.authHeaders)) {
      headers[k] = v;
    }
  }

  if (sessionKey) {
    headers["x-vertex-ai-session-id"] = sessionKey;
  }
  return headers;
}

/**
 * Forward request to upstream and handle retry if retryTarget is set.
 * openai 版本: retryBody 覆写 model, timeout gated on > 0。
 * 委托到 stageForwardWithRetry 共享实现; 独有 debug dump (body + md5) 保留在
 * caller 内联 (openai 独有的 md5 格式)。
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
  // ── Optional full-body dump (dev only) ── PROXY_DEBUG_DUMP_BODY=/tmp/xxx
  if (process.env.PROXY_DEBUG_DUMP_BODY) {
    try {
      const fs = await import("node:fs");
      const dir = process.env.PROXY_DEBUG_DUMP_BODY;
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const fn = `${dir}/${ts}-${sessionKeyForDebug ?? "nosid"}.json`;
      fs.writeFileSync(fn, JSON.stringify({ url: target.url, headers: upstreamHeaders, body: upstreamBody }, null, 2));
      console.log(`[dump-body] wrote ${fn}`);
    } catch (e) {
      console.log(`[dump-body] error: ${(e as Error).message}`);
    }
  }

  // ── openai 独有 md5 debug (sys + 全 msgs 两个 md5) ──
  if (process.env.PROXY_DEBUG_DUMP_OUTBOUND_MD5) {
    try {
      const msgs = (upstreamBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      const sysMsg = msgs.find((m) => m.role === "system");
      const sysStr = typeof sysMsg?.content === "string"
        ? sysMsg.content
        : sysMsg?.content ? JSON.stringify(sysMsg.content) : "";
      const msgsFullStr = JSON.stringify(msgs);
      const sysMd5 = createHash("md5").update(sysStr).digest("hex").slice(0, 12);
      const msgsFullMd5 = createHash("md5").update(msgsFullStr).digest("hex").slice(0, 12);
      console.log(
        `[outbound-md5] session=${sessionKeyForDebug ?? "?"} protocol=openai sysBytes=${sysStr.length} sysMd5=${sysMd5} msgsCount=${msgs.length} msgsFullBytes=${msgsFullStr.length} msgsFullMd5=${msgsFullMd5}`,
      );
    } catch (e) {
      console.log(`[outbound-md5] session=${sessionKeyForDebug ?? "?"} <error: ${(e as Error).message}>`);
    }
  }

  return stageForwardWithRetry({
    target, upstreamHeaders, upstreamBody, originalBody, originalHeaders,
    pipe, forwardTimeoutMs, sessionKeyForDebug, rateLimitContext,
    protocol: "openai",
    timeoutBehavior: "gated",
    buildRetryBody: (orig, retryModel) => ({ ...orig, model: retryModel }),
  });
}

/** Main handler for POST /v1/chat/completions (OpenAI compat). */
export async function runOpenaiChatPipeline(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const startTime = new Date().toISOString();
  const traceId = uuidv7();

  // ── Early auth (via shared stageAuth) ────────────────────────────────────
  // Verify BEFORE parsing the body so a rejected caller never triggers body
  // parsing or the alias-gate. `earlyVerify.userId` is reused later for
  // both the systemUser short-circuit and the normal pipeline.
  // handler.ts 历史行为: 只接受 Bearer, 忽略 x-api-key → 用 bearer-only 模式保等价。
  const earlyAuth = await stageAuth(c, "bearer-only");
  const earlyApiKey = earlyAuth.apiKey;
  const earlySpaceId = earlyAuth.spaceId;
  const earlyVerify = { userId: earlyAuth.userId, rejected: earlyAuth.rejected, rejectReason: earlyAuth.rejectReason };
  if (earlyAuth.rejected) {
    return c.json({ error: `Authentication failed: ${earlyAuth.rejectReason ?? "unknown"}` }, 401);
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  // Body is parsed BEFORE the systemUser short-circuit so the alias-gate and
  // `resolveModelId` fire uniformly for internal AND external callers. The
  // parsed object is later handed to `handleSystemUserPassthrough` (which
  // serialises it) so we never double-read `c.req`.
  // Parse via shared stage (also handles PROXY_DEBUG_DUMP_INBOUND dev-only dump)
  const parseResult = await stageParseBody(c);
  if (!parseResult.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // eslint-disable-next-line prefer-const
  let body = parseResult.body;

  // ── DEBUG: dump tools/instructions/metadata（Phase 1 workbuddy 调研）──
  // 仅在 sessionInit.debugVerboseLogging=true 时启用，生产环境默认关闭。
  if (config.sessionInit?.debugVerboseLogging) {
  try {
    const dbgPath = c.req.path;
    if (dbgPath.includes("/workbuddy/")) {
      // 只保留精简字段（不 dump 原始 tools 数组，避免超长被截断）
      const dumpKeys = [
        "tool_choice",
        "toolset",
        "tool_config",
        "response_format",
        "metadata",
        "client_metadata",
      ];
      const dump: Record<string, unknown> = { path: dbgPath, model: body.model };
      for (const k of dumpKeys) {
        if (k in body) dump[k] = (body as Record<string, unknown>)[k];
      }
      const toolsField = body?.tools;
      if (Array.isArray(toolsField)) {
        dump.tools_summary = toolsField.map((t: unknown) => {
          const tt = t as Record<string, unknown>;
          const fn = (tt as any).function ?? {};
          const paramProps = fn.parameters?.properties;
          return {
            type: tt.type,
            name: (tt as any).name ?? fn.name,
            description:
              typeof (tt as any).description === "string"
                ? String((tt as any).description).slice(0, 400)
                : typeof fn.description === "string"
                  ? String(fn.description).slice(0, 400)
                  : undefined,
            param_keys: paramProps && typeof paramProps === "object"
              ? Object.keys(paramProps)
              : undefined,
          };
        });
      }
      // messages[0] 若是 system，一起 dump（可能声明 tool 用法）
      const msgs = body?.messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const first = msgs[0] as Record<string, unknown>;
        if (first?.role === "system") {
          const content = typeof first.content === "string"
            ? first.content
            : JSON.stringify(first.content);
          dump.system_head = content.slice(0, 2000);
          dump.system_length = content.length;
        }
        dump.messages_count = msgs.length;
      }
      console.log(
        `[wb-tools-dump] path=${dbgPath} tools_count=${Array.isArray(toolsField) ? toolsField.length : 0}`,
      );
      console.log(`[wb-tools-dump-json] ${JSON.stringify(dump).slice(0, 60000)}`);

      // 额外：单独 dump AskUserQuestion 的完整 schema（Phase 1 关键调研）
      if (Array.isArray(toolsField)) {
        const askTool = toolsField.find((t: unknown) => {
          const tt = t as any;
          const name = tt?.name ?? tt?.function?.name;
          return name === "AskUserQuestion";
        });
        if (askTool) {
          console.log(
            `[wb-ask-user-schema] ${JSON.stringify(askTool).slice(0, 20000)}`,
          );
        }
      }
    }
  } catch (e) {
    console.log(`[wb-tools-dump] error: ${String(e)}`);
  }
  } // debugVerboseLogging gate

  // ── AgentStrategy 早期 resolve: stageGates 驱动 systemUser/modelGate/identity 门控 ──
  // 早于 model gate + systemUser + identity, 因为它们都要靠 stageGates。
  const _pathPartsEarly = c.req.path.split("/").filter(Boolean);
  const _agentFromPathEarly = _pathPartsEarly[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(_pathPartsEarly[0])
    ? _pathPartsEarly[0] : undefined;
  const _agentSourceEarly = _agentFromPathEarly ?? "claude-code";
  const _agentStrategy = resolveAgentStrategy(_agentSourceEarly);
  const _gates = _agentStrategy.stageGates;

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
  // instance carried any Option-2/3 conversation config (fix: 64e989a0 →
  // this file's next revision).
  // ── Early instance upstream config (via shared stage) ─────────────────
  // 详见 docs/design/2026-08-25-instance-upstream-config.md §7.3 / §7.5。
  const earlyResult = await stageInstanceUpstreamEarly({
    c, config, spaceId: earlySpaceId, earlyUserId: earlyVerify.userId,
    errorEnvelope: "openai",
  });
  if (earlyResult.blockedResp) return earlyResult.blockedResp;
  const _earlyAgent = earlyResult.agent;
  const _legacyProxy = earlyResult.legacyProxy;
  const _earlyConvResolution = earlyResult.earlyConvResolution;
  const _earlyExtractRow = earlyResult.earlyExtractRow;
  const _earlySysMatch = earlyResult.earlySysMatch;
  const _isCustomUpstream = earlyResult.isCustomUpstream;

  // ── Model gate + alias (gated by stageGates.modelGate) ────────────────
  // 未开门控 → 完全跳过 pricing 检查, alias 也不做 (行为等价 codex/wb minimal preset)。
  let modelId: string;
  if (_gates.modelGate) {
    const gateResult = stageModelGate(requestedModel, config, _isCustomUpstream);
    if (!gateResult.ok) {
      return c.json(buildUnregisteredModelErrorBody(requestedModel), 400);
    }
    modelId = gateResult.modelId;
    const modelAliasApplied = gateResult.aliasApplied && typeof body.model === "string";
    if (modelAliasApplied) body.model = modelId;
  } else {
    // gate 关闭时: modelId 仍需 resolve 保证下游 langfuse/logging 有值
    modelId = _isCustomUpstream ? requestedModel : resolveModelId(config.creditPricing, requestedModel);
  }

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

  // [debug] Log last 3 message roles and content types to diagnose session-init issues
  if (config.sessionInit?.enabled && messages.length > 2) {
    const tail = messages.slice(-3);
    const summary = tail.map((m: any, idx: number) => {
      const role = m.role;
      const ct = m.content;
      const contentType = typeof ct === "string" ? `string(${ct.slice(0, 80)})` :
        Array.isArray(ct) ? `array[${ct.map((b: any) => b.type).join(",")}]` :
        ct === null ? "null" : typeof ct;
      const tcid = m.tool_call_id;
      const tcs = m.tool_calls ? `tool_calls[${m.tool_calls.map((t: any) => t.id).join(",")}]` : "";
      return `[${idx}]role=${role} content=${contentType} tool_call_id=${tcid} ${tcs}`;
    }).join(" | ");
    console.log(`[session-init-debug] raw-tail msgs=${messages.length} ${summary}`);
  }

  // ── Resolve agent source from URL path (e.g. /claude-code/v1/chat/completions) ──
  const pathParts = c.req.path.split("/").filter(Boolean);
  const agentFromPath = pathParts[0] && !["v1", "proxy", "skill-bridge", "memory-bridge"].includes(pathParts[0])
    ? pathParts[0] : undefined;
  const agentSource = agentFromPath ?? "claude-code";
  // _agentStrategy / _gates 已在前面 resolve (agentSource 也许 differs from _agentSourceEarly
  // 因为下面 pathParts 用 filter(Boolean)[0] 提取; 早期资源用同样规则应等价)

  // ── Identity inspection (gated by stageGates.identityRecord) ────────────
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    reqHeaders[k] = v;
  }
  if (_gates.identityRecord) {
    inspectAndRecord("POST", c.req.path, reqHeaders, body as Record<string, unknown>, agentSource);
  }

  // ── Resolve apiKey → project name ──────────────────────────────────────
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const apiKey = extractBearerToken(authHeader);
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
  let userId = stageResolveUserId({ c, config, earlyVerifyUserId: earlyVerify.userId, logTag: "handler" });
  if (userId) keyId = userId;

  // Activate Redis storage early — must run BEFORE session init.
  if (config.redis?.enabled) {
    const { getInjectionPipeline } = await import("../../injection/index.js");
    getInjectionPipeline(config);
  }

  // ── Request kind classification (auxiliary detection for OpenAI-chat clients) ──
  // dsh (deepseek-harness) 会在 compaction 请求带 `x-deepseek-harness-compact: 1`
  // header,title-gen 靠 body 特征三合一。这类请求**不能**走 session-init form,
  // 也不能触发 mem 拦截 / L0 写入 / skill 提取 —— 应该直接透传上游。
  // codebuddy / claude-code 客户端 adapter classifyRequest 恒返 "main",行为无变。
  const { resolveAgentAdapter } = await import("../../agent-adapters/index.js");
  const _adapter = resolveAgentAdapter(agentSource);
  const _requestKind = _adapter.classifyRequest(body as Record<string, unknown>, c.req.path, lcHeaders);
  // 遗留 `/proxy/<spaceId>` 前缀与 auxiliary 共用这条门控：两者都不该碰记忆。
  // 前者是因为拿不到 agent 身份（agentSource 兜底成 claude-code），按错误画像
  // 注入比不注入更糟；压缩与计费不在这条门控下，照常生效。
  const isAuxiliary = _requestKind === "auxiliary" || _legacyProxy;
  if (isAuxiliary) {
    const _reason = _legacyProxy ? "legacy /proxy prefix" : "auxiliary";
    console.log(`[request-classify] session=${sessionKey} agent=${agentSource} → ${_reason} (skip session-init/mem/injection/L0/skill)`);
  }

  // ── dsh (deepseek-harness) CLI headless / no-preset bypass ──────────────
  // dsh 客户端在 headless bundle 或未挂 ask-user preset 时,body.tools 里
  // 不含 `ask_user_question` 工具。proxy 塞 fake `ask_user_question` tool_call
  // 会被 dsh agent-loop 校验为 unknown tool 直接抛错。此时直接 bypass
  // session-init 而非弹 form —— 没 UI 场景强弹表单没意义。
  //
  // 判定:agentSource=dsh 且 body.tools 非空且不含 ask_user_question。
  // (tools 空数组表示纯对话/aux,不用兜底;tools 里就有 ask_user_question 说明
  // 有 preset 挂 UI 工具,正常走 form。)
  //
  // NOTE(opencode): opencode CLI 同样不支持虚拟 ask_followup_question tool,
  // 但走独立的 header-driven session-init 分支(见下方 opencode 特化块),
  // 因此不需要走这里的 headless bypass —— opencode 能吃 mem 命令纯文本响应,
  // 也需要 injection / L0 / skill 提取,只是不能弹 form。
  const _dshHeadless = agentSource === "dsh" && (() => {
    const tools = (body as { tools?: unknown }).tools;
    if (!Array.isArray(tools) || tools.length === 0) return false;
    return !tools.some((t) => {
      const fn = (t as { function?: { name?: string }; name?: string })?.function;
      const n = fn?.name ?? (t as { name?: string })?.name;
      return n === "ask_user_question";
    });
  })();
  if (_dshHeadless) {
    console.log(`[request-classify] session=${sessionKey} agent=dsh headless/no-preset (no ask_user_question tool) → bypass session-init, direct passthrough`);
  }

  // ── Client capabilities detection ─────────────────────────────────────────
  // 探测客户端"能否响应 proxy 发起的 fake ask tool_call"。
  //
  // 当前仅对 workbuddy 做实质判定：新版 workbuddy 官方 tools 集合里拿掉了
  // AskUserQuestion（现只剩 20 个工具），proxy 侧继续发 tool_calls 会被客户端
  // 收下但不知道怎么渲染 → 卡死在 pending。此时需要降级走文字模式
  // （content chunk + markdown + 纯文字解析）。
  //
  // 其他客户端（codebuddy / claude-code / dsh / codex / opencode / hermes /
  // openclaw）一律 askUserQuestion=true，保持既有行为不变。dsh headless 场景走
  // 上面独立的 _dshHeadless bypass 分支，不受本探测影响。
  const { detectClientCapabilities } = await import("../../session/client-capabilities.js");
  const _capabilities = detectClientCapabilities(agentSource, body);
  if (agentSource === "workbuddy" && !_capabilities.askUserQuestion) {
    console.log(`[request-classify] session=${sessionKey} agent=workbuddy no-AskUserQuestion tool → text-mode session-init`);
  }

  // ── mem:session-reset pre-hook (via shared stage) ──
  const resetResp = await stageSessionResetPreHook({
    c, config, body, agentSource, sessionKey, spaceId, userId,
    isAuxiliary, dshHeadless: _dshHeadless, isStream,
    protocol: "openai",
  });
  if (resetResp) return resetResp;

  // ── Session Init (before injection pipeline) ─────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("../../injection/types.js").AssetCapabilityFlags | undefined;
  let injectedSkipped = !conversationId || isAuxiliary || _dshHeadless;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  console.log(`[injection-debug] conversationId=${conversationId} sessionKey=${sessionKey} userId=${userId} agentSource=${agentSource} kind=${_requestKind} dshHeadless=${_dshHeadless} sessionInitEnabled=${config.sessionInit?.enabled} injectionEnabled=${config.injection?.enabled} injectors=${JSON.stringify(config.injection?.injectors)} injectedSkipped=${injectedSkipped} spaceId=${spaceId}`);
  if (config.sessionInit?.enabled && conversationId && !isAuxiliary && !_dshHeadless) {
    try {
      // Round 18: session-init 主编排走 shared stageSessionInitOrchestrate;
      // openai-chat 4 个 callback:
      //   - synthesizeMessages: body.messages 原样
      //   - buildRecoverInitResult: injectSessionContextWithToggles → messages (openai)
      //   - buildInterceptResponse: 直接 initResult.response (状态机内建)
      //   - buildReqCtx: protocol="openai" + questionsAsArray 检测 + capabilities 透传
      //
      // kernel /v3/meta/* 走 x-tdai-user-key 鉴权;
      // 优先级: 客户端 Authorization bearer > config.tdai.apiKey (openai-chat 独有).
      // 与 workbuddyHandler.ts 里的 kernelUserKey 逻辑对齐 (那里也是客户端优先)。
      const kernelUserKey = apiKey || config.tdai?.apiKey || "";
      const _orch = await stageSessionInitOrchestrate({
        agentSourceForState: agentSource,
        sessionKey, userId: userId || null, spaceId,
        config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
        kernelUserKey,
        headers: lcHeaders,
        recoveryMessages: (body.messages as Array<Record<string, unknown>>) ?? [],
        synthesizeMessages: () => (body.messages as Array<Record<string, unknown>>) ?? [],
        buildRecoverInitResult: async (recovered) => {
          const { injectSessionContextWithToggles } = await import("../../session/context-injector.js");
          const inMsgs = (body.messages as Array<Record<string, unknown>>) ?? [];
          const outMsgs = recovered.bypassed
            ? inMsgs
            : injectSessionContextWithToggles(
                inMsgs,
                recovered.agentDetail ?? null,
                recovered.taskDetail ?? null,
                config.sessionInit,
                sessionKey,
              );
          return { messages: outMsgs as Record<string, unknown>[] };
        },
        buildReqCtx: () => {
          // 检测客户端 ask_followup_question schema 里 questions 字段是否声明为 array;
          // CB v1.106+ 声明为 array 且做 type check; 老版本无 schema 或 questions 无 type
          let questionsAsArray = true;
          const clientTools = Array.isArray(body.tools) ? body.tools as unknown[] : [];
          const afqTool = clientTools.find((t: any) =>
            t?.function?.name === "ask_followup_question" || t?.name === "ask_followup_question"
          ) as Record<string, unknown> | undefined;
          if (afqTool) {
            const params = (afqTool as any).function?.parameters ?? (afqTool as any).parameters;
            const qType = params?.properties?.questions?.type;
            questionsAsArray = qType === "array";
          } else if (clientTools.length === 0) {
            questionsAsArray = false;
          }
          return { stream: isStream, modelId: modelId as string, protocol: "openai", questionsAsArray, capabilities: _capabilities };
        },
        buildInterceptResponse: (initResult) => initResult.response ?? null,
      });
      if (!_orch.proceed) return _orch.response!;
      const initResult = _orch.initResult!;
      const wentThroughSessionInitStateMachine = _orch.wentThroughStateMachine;

      console.log(`[injection-debug] initResult session=${sessionKey} intercepted=${initResult.intercepted} bypassed=${initResult.bypassed} justRegistered=${initResult.justRegistered} resetFlow=${(initResult as any).resetFlow} hasSessionInfo=${!!initResult.sessionInfo} hasAgentDetail=${!!initResult.agentDetail}`);
      // 见 anthropicHandler 对称位置：只在真正走 sessionInit state machine 时继承。
      if (wentThroughSessionInitStateMachine && initResult.justRegistered) sessionJustRegistered = true;

      // Case 1.5: Bypass path → skip ALL injection hooks (via shared stageSessionBypass)
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
        userKey: apiKey || null,
        warnPrefix: "[asset-capability] resolve failed:",
      });

      // Restore space_id from the URL BEFORE prewarm. Recovery paths and
      // legacy sessions can hydrate a SessionInfo whose `space_id` is empty;
      // prewarm calls (skill-injector, memory-injector) route to the correct
      // kernel tenant via this field, so a missing value at this point
      // silently poisons the prewarm cache with empty results.
      // See BUG-skill-injection-multinode.md §3.3(B).
      const { restoreSessionSpaceId } = await import("../../session/restore-space-id.js");
      restoreSessionSpaceId(
        initResult.sessionInfo as Record<string, unknown> | null | undefined,
        spaceId,
      );

      // Prewarm 前置短路：mem-command 命中的 turn 不 forward 上游、也不消费
      // hook-cache，若照常 prewarm 会白白多花 2-3s + 3 次网络请求（knowledge
      // 33% timeout 会被放大）。这里先做纯字符串解析（<1ms、无副作用），
      // 命中就置 memCommandPending 让 prewarm 分支短路；实际 mem-command 执行
      // 仍在下方原位置进行，L0 write / skill extract / langfuse 全部保留。
      //
      // fallback 语义：sessionJustRegistered 在此已定型（见上文 L786），
      // checkFirst 场景可安全复用。
      let memCommandPending = false;
      if (!isAuxiliary && !_dshHeadless) {
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
            "[mem-command] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
          // peek 失败不阻塞主链路，退化为原有行为（正常 prewarm）。
        }
      }

      // Case 2 success → await prewarm so the first-turn pipeline always
      // hits the cache. A fire-and-forget void() here caused the bug where
      // the pipeline ran before the cache was populated, silently injecting
      // zero blocks for the entire first turn.
      await stagePrewarmInjection({
        bypassed: !!initResult.bypassed,
        justRegistered: !!initResult.justRegistered,
        sessionInfo: initResult.sessionInfo,
        agentDetail: initResult.agentDetail,
        taskDetail: initResult.taskDetail,
        memCommandPending,
        config, sessionKey, userId, agentSource, spaceId, assetCapabilities,
        callerUserKey: apiKey ?? undefined,
        logTag: "[hook-cache] handler prewarm error:",
      });

      // Case 2: Messages were cleaned → update body
      if (initResult.messages) {
        body = { ...body, messages: initResult.messages };
        messages = initResult.messages as unknown[];
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      // Belt-and-suspenders: also restore on the local `sessionInfo` alias.
      // In practice this is the same object reference as
      // `initResult.sessionInfo` (already restored above), but the second
      // call is a no-op and guards against future refactors that copy
      // the object between these two lines.
      restoreSessionSpaceId(sessionInfo, spaceId);

      // 记录 resetFlow 信息到外层，session-init 块结束后用于返回确认响应
      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "未知",
          // agentIdShort 字段名沿用历史，但此处**存完整 agent_id**（如 agt-1celthr7yn）。
          // 之前 slice(-8) 只留后 8 位会显示成 "elthr7yn" 这种截断串，用户完全看不懂，
          // 与 team 截断问题同源。agent id 本身就短，全量展示无害且更可读。
          agentIdShort: initResult.sessionInfo?.agent_id
            ? String(initResult.sessionInfo?.agent_id) : "",
          // teamName 来自 session-init（cachedTeams[selected].team_name）；
          // teamId 存**完整** team_id（如 team-wyuyb7sion）—— 之前 slice(-8)
          // 会显示成 "uyb7sion" 用户看不懂，且 teamName 为空时兜底更差。
          teamName: initResult.teamName ?? undefined,
          teamId: initResult.sessionInfo?.team_id
            ? String(initResult.sessionInfo?.team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[session-init] Error in handleSessionInit:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectedSkipped = true;
    }
  }

  // ── mem:session-reset 完成确认 (via shared stage) ────────────────────────
  if (_resetFlowResult) {
    return stageSessionResetConfirmation({
      resetFlowResult: _resetFlowResult,
      protocol: "openai",
      isStream,
    });
  }

  // ── mem: command intercept ────────────────────────────────────────────────
  // 位置对齐 anthropicHandler.ts:847 —— session init 完成后、injection 之前。
  // 命中时：执行命令 → 写 L0 → 触发 skill extract → 伪造 OpenAI 响应返回，跳过
  // injection（不破坏 KV cache）和上游转发（零 token 消耗）。命令拦截恒定启用，
  // 未知命令由 executeMemCommand 内的 KNOWN_COMMANDS 兜底提示。
  //
  // 解决的坑：CodeBuddy 走 OpenAI 协议命中本 handler，之前 mem-command intercept
  // 只挂在 anthropicHandler，CB 用户发 `mem:help` 会直接透传到上游 LLM，返回
  // LLM 幻觉出来的"帮助文本"（含 mem:atoms/mem:profile/mem:conversations 等
  // 根本不存在的命令）。本次抓包 (langfuse trace d814929a...) 实证后补齐。
  //
  // 请求分类：OpenAI 协议不做 CC 的 fork/sidequery 分流（handler.ts 没接 CC
  // routing），所有请求都视为 main —— 与 codebuddy adapter classifyRequest 一致。
  // ── mem: command intercept (via shared stage) ────────────────────────
  {
    const { extractSimpleMessages } = await import("../../mem-command/index.js");
    const memResp = await stageMemCommandIntercept({
      enabled: !isAuxiliary && !_dshHeadless,
      body: body as Record<string, unknown>,
      agentSource, sessionKey,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      injectionSkipped: injectedSkipped,
      sessionJustRegistered,
      config, spaceId, userId, apiKey: apiKey || "",
      isStream, protocol: "openai",
      modelId: modelId as string,
      upstreamUrl: (agentFromPath ? config.upstream.agents?.[agentFromPath]?.url : undefined) ||
        config.upstream.url,
      messages: messages as unknown[],
      createTdaiClientFn: createTdaiClient,
      bodyMessages: extractSimpleMessages(body.messages),
      assistantContentFormat: "openai-string",
      startTime, keyId, assetCapabilities,
      upstreamProtocol: "openai",
    });
    if (memResp) return memResp;
  }

  // aux 请求(compaction/title)/ dsh headless(无 UI 无 preset)不写 L0 —— 直接透传
  const tdaiClient = isAuxiliary || _dshHeadless || assetCapabilities?.chat_memory === false ? null : createTdaiClient(config, spaceId);
  const tdaiIdentity = injectedSkipped
    ? null
    : deriveTdaiIdentity({
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        userId: userId || null,
        sessionKey,
      });
  // OpenCode places a fresh human turn at the end of messages. A tool-loop
  // continuation ends with a tool message and must not be counted as another
  // human input. Capture this before injection can prepend recalled memories.
  const lastInboundMessage = messages[messages.length - 1] as Record<string, unknown> | undefined;
  const opencodeUserQuery = agentSource === "opencode"
    ? (lastInboundMessage?.role === "user" && !isAuxiliary
        ? (opencodeAdapter.extractUserText(lastInboundMessage.content) ?? "")
        : "")
    : null;
  const tdaiUserMessage: TdaiMessage | null = agentSource === "opencode"
    ? (opencodeUserQuery ? { role: "user", content: opencodeUserQuery } : null)
    : extractLatestUserMessage(messages);

  // ── Context injection (via shared stage, before cost guard) ─────────────
  {
    const injected = await stageInjectionRunner({
      skip: injectedSkipped,
      config, body, protocol: "openai", messages,
      traceId, keyId, modelId: modelId as string, isStream, agentSource,
      userId, spaceId, sessionKey, requestPath: c.req.path,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      assetCapabilities,
      callerUserKey: apiKey,
    });
    body = injected.body;
    messages = injected.messages;
  }

  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  // ── Resolve forward target (opaque extension — no routing logic here) ──
  // upstream.agents[agent] is a single map keyed by agent name — same lookup
  // as anthropicHandler. Empty / missing entry → fall back to upstream.url,
  // preserving legacy behavior for configs that don't declare `agents:` at all.
  // ── Resolve forward target (via shared stage) ────────────────────────
  const resolvedTarget = await stageResolveTargetFull({
    c, config, protocol: "openai", agentFromPath,
    keyId, sessionKey, messages, hasTools, body,
    modelId: modelId as string, headers: lcHeaders,
    traceId, startTime, spaceId,
  });
  const target = resolvedTarget.target;
  let effectiveApiKey = resolvedTarget.effectiveApiKey;
  const forwardEndpoint = resolvedTarget.forwardEndpoint;
  const costGuardMode = resolvedTarget.costGuardMode;

  // ── Instance upstream config override (via shared stage) ──────────────
  // b11bf612 GLM /v1 auto-insert 修复走 joinUrl, stageInstanceUpstreamOverride 内部
  // 已用 joinUrl(row.base_url, c.req.path) 替换手动拼接; openai 协议 joinUrl 不补 /v1
  // (anthropic-only 判据), 行为与旧手拼一致。
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

  // ── Trace-level tags ──
  // agent_source 标明客户端族群（codebuddy / claude-code / codex / …），供
  // Langfuse 上按客户端筛选 trace；protocol 只区分 wire 协议，同一 wire
  // 可对应多个客户端。
  const traceTags: string[] = [
    `agent_source:${agentSource}`,
    "protocol:openai",
    isStream ? "stream" : "non-stream",
    `session:${sessionKey}`,
  ];

  // ── Langfuse turn context: one trace = one turn (deterministic traceId) ──
  // Same (sessionKey, turnSeq) across a turn's tool-loop requests → same trace.
  // Prefer the extension's monotonic per-session turnSeq (survives context
  // compaction); fall back to the stateless count when it's not tracked.
  // Both sources drop back to 1 when their state is lost (truncated history /
  // expired counter), colliding with the usage rows this session already wrote
  // — Redis, when enabled, turns them into a per-session sequence that only
  // ever moves forward. See resolveMonotonicTurnSeq.
  // ── Turn context 装配 via shared stageBuildLangfuseTurnContext ──
  // 58e4c55b opencode fix: opencode 的 userQuery 由 caller 算好后覆写, 不走
  // stage 内默认 resolveLatestUserQuery (见上方 opencodeUserQuery 计算与注释)。
  const { turnSeq, lf } = await stageBuildLangfuseTurnContext({
    config, sessionKey, keyId, target, messages, protocol: "openai",
    traceTags, path: c.req.path, headers: lcHeaders, body,
    userQueryOverride: opencodeUserQuery,
  });
  stageReportAnalyzerTrace({ config, target, traceId, lf, keyId, sessionKey, turnSeq, startTime, spaceId });

  // ── Langfuse debug metadata (only when config.langfuse.debug=true) ────────
  // CB / cursor / windsurf 走 OpenAI 协议命中本 handler；开 debug 时把请求
  // 结构 + 客户端指纹塞进 Langfuse observationMetadata，供抓包分析用。
  // 默认关（{}），不污染线上 trace。详见 common/langfuse-debug.ts。
  const langfuseDebug = config.langfuse.debug === true;
  const debugMetadata = buildRequestDebugMetadata({
    debug: langfuseDebug,
    body: body as Record<string, unknown>,
    headers: reqHeaders,
    agentSource,
    // 本 handler 不做 CC 客户端的 fork/sidequery 分流（只 anthropicHandler 走那套）
    spaceId,
    turnSeq,
    requestPath: c.req.path,
    protocol: "openai",
  });

  // ── Opik: create trace (gated by stageGates.opik) ─────────────────────
  const forkTraceId = _gates.opik ? opikCreateTrace(config, {
    traceId,
    projectName: keyId,
    name: `${target.model} / ${keyId}`,
    startTime,
    input: { messages: flattenMessagesForOpik(messages) },
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
  const upstreamHeaders = buildUpstreamHeaders(c, config, target, sessionKey, effectiveApiKey);

  // Optional private preparation stage. It rewrites `body` / `messages` in
  // place, so it has to land after every host-side mutation (injection, agent
  // overrides) and before the upstream body is assembled below. The host does
  // not interpret the returned stats — see request-prepare-adapter.ts.
  const preparedStats = await prepareUpstreamRequest({
    config,
    protocol: "openai",
    body,
    messages,
    sessionKey,
    pipe,
    upstreamCall: {
      upstreamUrl: target.url,
      headers: upstreamHeaders,
      model: target.model,
      tools: body.tools,
      bodyOverrides: target.bodyOverrides ?? undefined,
    },
    userQuery: lf.userQuery,
    spaceId,
    lf,
    opikTraceId: traceId,
    opikKeyId: keyId,
    skipPrepare: costGuardMode === "cheap",
  });

  const upstreamBody = buildUpstreamBody(body, target);
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
  // Retry uses the same effective key as the primary path — when it
  // resolves to "" (agent entry present but no apiKey), retry also runs
  // on the client's own key, preserving the passthrough intent.
  if (effectiveApiKey) {
    originalHeaders["authorization"] = `Bearer ${effectiveApiKey}`;
  }

  // Inject stream_options.include_usage for OpenAI compat
  if (isStream) {
    upstreamBody.stream_options = {
      ...(typeof upstreamBody.stream_options === "object" && upstreamBody.stream_options !== null
        ? (upstreamBody.stream_options as object)
        : {}),
      include_usage: true,
    };
  }

  // ── Forward to upstream (with automatic retry if configured) ──────────────
  // forwardTimeout gate 关闭 → 传 0 使 stageForwardWithRetry 的 timeoutBehavior='gated' 分支不设 AbortSignal
  const forwardTimeoutMs = _gates.forwardTimeout ? (config.server.forwardTimeoutMs ?? 600_000) : 0;
  // Pass target.url so the FORWARD log reflects the actual per-agent upstream
  // (otherwise it prints the global default and misleads triage).
  pipe.forwardStart(target.url);
  let upstreamResp: Response;
  let retried = false;

  try {
    // Rate limit 只对官方模型生效:custom upstream 用的是用户自己的 base_url + api_key,
    // 上游 quota 由用户自己管;proxy 的 QPM/TPM 桶是运营方按自家上游算的,套到 custom
    // 上等于错杀。传 undefined → forwardWithRetry 内 `if (rateLimitContext)` 自然跳过。
    // rateLimit gate 关闭时同样跳过 (codex/wb bootstrap B1 修复用)。
    const rateLimitContext = (_isCustomUpstream || !_gates.rateLimit) ? undefined : { config, instanceId: spaceId || undefined };
    const result = await forwardWithRetry(
      target, upstreamHeaders, upstreamBody,
      body, originalHeaders,
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
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      statusMessage: err instanceof Error ? err.message : "Upstream request failed",
      extraTags: ["error"],
      observationMetadata: { stage: "forward", ...debugMetadata },
    });
    return c.json({ error: "Upstream request failed" }, 502);
  }

  // Build response headers (strip hop-by-hop) — via shared filterResponseHeaders
  const respHeaders = filterResponseHeaders(upstreamResp.headers);

  // Upstream request id from response header (tokenhub / OpenAI-compatible
  // gateways set `x-request-id`). Used for cross-system tracing/audit.
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";

  const effectiveModel = retried && target.retryTarget
    ? target.retryTarget.model
    : target.model;

  // A retry falls back to the model the client asked for, so the request ends
  // up costing what it would have cost unrouted — no saving to attribute.
  const routedFrom = retried ? "" : target.routedFrom;
  // `routedFrom` is also present in cost-guard's opaque logMeta. Keep the
  // normalized post-retry value authoritative so fallback requests never book
  // savings or carry stale route attribution.
  const { routedFrom: _ignoredRoutedFrom, ...routeLogMeta } = target.logMeta;
  const responseLogMeta = {
    ...routeLogMeta,
    ...(retried ? { retrySuccess: true } : {}),
  };

  // ── Streaming response ───────────────────────────────────────────────────
  if (isStream) {
    if (!upstreamResp.body) {
      pipe.streamDone(null);
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }

    // Log upstream error body for 4xx responses
    if (!retried && upstreamResp.status >= 400 && upstreamResp.status < 500) {
      const [errBodyStream, clientPassStream] = upstreamResp.body.tee();
      const errText = await new Response(errBodyStream).text();
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
        input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
        status: upstreamResp.status,
        statusMessage: errText.slice(0, 500),
        extraTags: ["error"],
        observationMetadata: { stage: "upstream", stream: true, ...debugMetadata },
      });
      pipe.streamDone(null);
      return new Response(clientPassStream, { status: upstreamResp.status, headers: respHeaders });
    }

    pipe.streamStart();

    const tapCtx: TapContext = {
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
      retried,
      logMeta: responseLogMeta,
      routedFrom,
      tdaiClient,
      tdaiIdentity,
      tdaiUserMessage,
      assetCapabilities,
      pipe,
      sessionKeyForSkill: sessionKey,
      agentSource,
      isAuxiliary,
      isDshHeadless: _dshHeadless,
      sessionInfo,
      lf,
      spaceId,
      upstreamRequestId,
      langfuseDebug,
      debugMetadata,
      preparedStats,
      skipCreditReport,
      isCustomUpstream: _isCustomUpstream,
      gates: _gates,
    };
    const passthrough = createUsageTapTransform(tapCtx);
    // 顺序要紧：tap 在前，读到的是模型原始输出；剥离在后，只影响客户端那一份。
    const tappedStream = upstreamResp.body
      .pipeThrough(passthrough)
      .pipeThrough(createCfqStripStream(
        "openai",
        preparedStats,
        createCfqStripObserver(pipe),
      ));

    return new Response(tappedStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming response ───────────────────────────────────────────────
  const respText = await upstreamResp.text();
  const endTime = new Date().toISOString();

  let usage: Record<string, unknown> | null = null;
  let assistantMessage: Record<string, unknown> | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const choices = respJson.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as Record<string, unknown>).message;
      if (msg && typeof msg === "object") {
        assistantMessage = msg as Record<string, unknown>;
      }
    }
  } catch {
    // non-JSON upstream response
  }

  const logMeta = responseLogMeta;

  // Report the completed response to the extension (same signal the streaming
  // path emits from its tap). Fire-and-forget.
  void notifyUpstreamResponse(
    config,
    {
      protocol: "openai",
      sessionKey,
      model: effectiveModel,
      stream: false,
      turnSeq: lf.turnSeq,
      text: typeof assistantMessage?.content === "string" ? assistantMessage.content : "",
      toolCalls: (Array.isArray(assistantMessage?.tool_calls) ? assistantMessage.tool_calls : [])
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const argsVal = fn?.arguments;
          return {
            id: (t.id as string) ?? "",
            name: (fn?.name as string) ?? "",
            arguments: typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? ""),
          };
        })
        .filter((tc) => tc.id && tc.arguments),
      usage: usage ?? {},
    },
    pipe,
  );

  // 内部使用埋点：非流式响应里的 tool_calls 逐个记 model_intent。
  try {
    const toolCalls = assistantMessage?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const intents = toolCalls
        .map((tc) => {
          const t = tc as Record<string, unknown>;
          const fn = t.function as Record<string, unknown> | undefined;
          const name = (fn?.name as string) ?? "";
          const argsVal = fn?.arguments;
          const argsStr = typeof argsVal === "string" ? argsVal : JSON.stringify(argsVal ?? "");
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
    }
  } catch {
    // 埋点绝不阻塞业务
  }

  if (usage) {
    // custom upstream 不记 token 桶(与 enforceRateLimit 对称:官方限流桶只算官方调用)
    // rateLimit gate 关闭时同步跳过 token 记账,与限流本身对称
    if (!_isCustomUpstream && _gates.rateLimit) {
      await recordInputTokenUsage({
        config,
        instanceId: spaceId || undefined,
        modelId: effectiveModel,
        usage,
        protocol: "openai",
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

    const outputMessages = assistantMessage ? [assistantMessage] : [];
    if (_gates.opik) {
      opikUpdateTrace(config, {
        traceId,
        projectName: keyId,
        endTime,
        output: outputMessages,
        usage,
      });
      if (forkTraceId && !config.opik.stripRequestLogContent) {
        opikUpdateTrace(config, {
          traceId: forkTraceId,
          projectName: "request_log",
          endTime,
          output: outputMessages,
          usage,
        });
      }
    }

    // 58e4c55b: opik LLM span 保留在 usage 块内 (span 需要 usage 数据);
    // recordTdaiTurn + langfuseReportGeneration 外移到下面的 upstreamResp.ok 块,
    // 让"上游 200 但没 usage"的成功响应也照常写 L0 + langfuse generation。
    if (_gates.opik) {
      opikCreateLlmSpan(config, {
        traceId,
        projectName: keyId,
        name: effectiveModel,
        startTime,
        endTime,
        inputMessages: flattenMessagesForOpik(messages),
        outputMessage: assistantMessage,
        model: effectiveModel,
        usage,
        tags: [
          "non-stream",
          ...(retried ? ["retry"] : []),
        ],
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
  }

  // A successful completion still has a conversation and a trace when the
  // upstream omits usage. Only token accounting requires usage data.
  if (upstreamResp.ok) {
    if (!usage) pipe.info("USAGE_MISSING", "non-stream response had no usage object");
    if (tdaiClient && isExtractionAllowed(config, "tdai-memory")) {
      await recordTdaiTurn(tdaiClient, tdaiIdentity, tdaiUserMessage, assistantContentForTdai(assistantMessage));
    } else if (tdaiClient) {
      logExtractionSkipped(config, "tdai-memory", sessionKey);
    }

    // Langfuse: report this LLM call as a generation under the turn trace.
    langfuseReportGeneration({
      traceId: lf.traceId,
      name: effectiveModel,
      model: effectiveModel,
      startTime,
      endTime,
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      output: assistantMessage,
      usage: usage ?? undefined,
      traceName: lf.traceName,
      userId: lf.userId,
      sessionId: lf.sessionId,
      tags: lf.tags,
      traceInput: lf.userQuery || undefined,
      traceOutput: assistantMessage ?? undefined,
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
      input: buildLangfuseInputChat(messages, langfuseDebug, flattenMessagesForOpik),
      status: upstreamResp.status,
      statusMessage: respText.slice(0, 500),
      extraTags: ["error"],
      observationMetadata: { stage: "upstream", stream: false, ...debugMetadata },
    });
  }

  pipe.responseDone(usage);

  // Skill extract trigger — count tool calls + buffer conversation.
  // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
  // aux 请求(compaction/title)/dsh headless 不触发 skill 提取 —— 保持归档 buffer 语义纯净
  if (!isAuxiliary && !_dshHeadless && isExtractionAllowed(config, "skill")) {
    await triggerSkillExtractIfReady({
      config,
      sessionKey,
      agentSource,
      sessionInfo,
      inputMessages: messages,
      assistantMessage,
      protocol: "openai",
      assetCapabilities,
    });
  } else if (!isAuxiliary && !_dshHeadless) {
    logExtractionSkipped(config, "skill", sessionKey);
  }

  // Credit usage reporting (non-streaming, gated by stageGates.creditReport).
  // 失败通过 x-credit-report-error 响应头透出, 不覆盖 LLM 响应体; 计费失败会
  // 同时写 CH raw 兜底记账。skipCreditReport: instance custom model → 用户自付, 跳过。
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
    "openai",
    respText,
    preparedStats,
    createCfqStripObserver(pipe),
  );
  return new Response(clientRespText, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}


function assistantContentForTdai(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n") || null;
  }
  return content == null ? null : JSON.stringify(content);
}

function outputMessageContent(message: Record<string, unknown> | null): string | null {
  return assistantContentForTdai(message);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface TapContext {
  config: ProxyConfig;
  modelId: string;
  keyId: string;
  sessionKey: string;
  upstreamUrl: string;
  traceId: string;
  /** Undefined when opik gate is off (no fork trace created). */
  forkTraceId?: string;
  requestPath: string;
  startTime: string;
  inputMessages: unknown[];
  retried: boolean;
  logMeta: Record<string, unknown>;
  /** Requested model when the router forwarded elsewhere; "" otherwise. */
  routedFrom: string;
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
  pipe: ReturnType<typeof createPipeline>;
  /** For skill extract trigger; null when session_init is disabled. */
  sessionKeyForSkill: string;
  /** Client type (URL path 第一段) — 透传给 extract trigger 作为三段隔离键之一。 */
  agentSource: string;
  /** True when this request was classified as auxiliary (compaction/title-gen) —
   * downstream L0/skill extract paths must skip to keep buffer semantics clean. */
  isAuxiliary: boolean;
  /** True when this dsh request came from CLI headless / no-preset (no ask_user_question
   * in tools) — behaves like aux for downstream side-effects. */
  isDshHeadless: boolean;
  sessionInfo: Record<string, unknown> | null | undefined;
  /** Langfuse turn-trace context (trace = one turn). */
  lf: LangfuseTurnContext;
  /** Space/tenant ID from request path. */
  spaceId?: string;
  /** Upstream response header `x-request-id` (empty when not returned). */
  upstreamRequestId?: string;
  /** `config.langfuse.debug === true` 的求值结果。 */
  langfuseDebug: boolean;
  /** buildRequestDebugMetadata 结果；debug=false 时为 {}。 */
  debugMetadata: Record<string, unknown>;
  /** Opaque counters from the request-preparation stage; null when it didn't run. */
  preparedStats: Record<string, unknown> | null;
  /** Instance upstream config: skip credit reporting for custom model. */
  skipCreditReport?: boolean;
  /** true when the request is routed to a custom upstream (user's own base_url + api_key). */
  isCustomUpstream?: boolean;
  /** stageGates — 决定 stream 尾部各 stage 是否触发 */
  gates?: import("../strategies/agent/types.js").StageGates;
}

/** Accumulated tool call state during SSE streaming. */
interface ToolCallAccumulator {
  id: string;
  type: string;
  functionName: string;
  functionArguments: string;
}

/** Result of extracting content + tool_calls from SSE text. */
interface SseExtractResult {
  content: string;
  toolCallDeltas: Array<{ index: number; id?: string; type?: string; functionName?: string; functionArguments?: string }>;
}

/** Extract assistant content and tool_call deltas from OpenAI SSE text. */
function extractSseContentAndTools(sseText: string): SseExtractResult {
  let content = "";
  const toolCallDeltas: SseExtractResult["toolCallDeltas"] = [];

  for (const line of sseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const evt = JSON.parse(dataStr) as Record<string, unknown>;
      const choices = evt.choices;
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (typeof delta?.content === "string") {
          content += delta.content;
        }
        const tcArr = delta?.tool_calls;
        if (Array.isArray(tcArr)) {
          for (const tc of tcArr) {
            const t = tc as Record<string, unknown>;
            const idx = typeof t.index === "number" ? t.index : 0;
            const fn = t.function as Record<string, unknown> | undefined;
            toolCallDeltas.push({
              index: idx,
              id: typeof t.id === "string" ? t.id : undefined,
              type: typeof t.type === "string" ? t.type : undefined,
              functionName: typeof fn?.name === "string" ? fn.name : undefined,
              functionArguments: typeof fn?.arguments === "string" ? fn.arguments : undefined,
            });
          }
        }
      }
    } catch {
      // ignore malformed SSE lines
    }
  }
  return { content, toolCallDeltas };
}

/** Merge accumulated tool_call deltas into complete tool_call objects. */
function mergeToolCallDeltas(
  accumulators: Map<number, ToolCallAccumulator>,
  deltas: SseExtractResult["toolCallDeltas"],
): void {
  for (const d of deltas) {
    let acc = accumulators.get(d.index);
    if (!acc) {
      acc = { id: "", type: "function", functionName: "", functionArguments: "" };
      accumulators.set(d.index, acc);
    }
    if (d.id) acc.id = d.id;
    if (d.type) acc.type = d.type;
    if (d.functionName) acc.functionName += d.functionName;
    if (d.functionArguments) acc.functionArguments += d.functionArguments;
  }
}

/** Create a TransformStream that passes bytes through unchanged,
 *  while extracting usage/content/tool_calls from SSE events in-band.
 */
function createUsageTapTransform(ctx: TapContext): TransformStream<Uint8Array, Uint8Array> {
  const { config, modelId, keyId, sessionKey, upstreamUrl, traceId, forkTraceId, startTime, inputMessages, retried, logMeta, pipe, lf, spaceId, upstreamRequestId } = ctx;

  const decoder = new TextDecoder();
  let sseBuf = "";
  let lastUsage: Record<string, unknown> | null = null;
  let assistantContent = "";
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

  function processSseChunk(chunk: string): void {
    sseBuf += chunk;
    const parts = sseBuf.split("\n\n");
    sseBuf = parts.pop() ?? "";
    for (const part of parts) {
      const usage = extractSseUsage(part);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(part);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }
  }

  async function finalize(): Promise<void> {
    if (sseBuf.trim()) {
      const usage = extractSseUsage(sseBuf);
      if (usage) lastUsage = usage;
      const { content, toolCallDeltas } = extractSseContentAndTools(sseBuf);
      assistantContent += content;
      mergeToolCallDeltas(toolCallAccumulators, toolCallDeltas);
    }

    const endTime = new Date().toISOString();

    let outputMessage: Record<string, unknown> | null = null;
    if (assistantContent || toolCallAccumulators.size > 0) {
      if (toolCallAccumulators.size > 0) {
        const toolCallEntries = Array.from(toolCallAccumulators.entries())
          .sort(([a], [b]) => a - b)
          .map(([, acc]) => JSON.stringify({ tool_call_id: acc.id, tool_name: acc.functionName, arguments: acc.functionArguments }, null, 2))
          .join("\n\n");
        const parts: string[] = [];
        if (assistantContent) parts.push(assistantContent);
        parts.push(toolCallEntries);
        outputMessage = { role: "assistant", content: parts.join("\n\n") };
      } else {
        outputMessage = { role: "assistant", content: assistantContent };
      }
    }

    // Report the completed response to the extension. Fire-and-forget; the
    // client has already been served by this point.
    void notifyUpstreamResponse(
      config,
      {
        protocol: "openai",
        sessionKey,
        model: modelId,
        stream: true,
        turnSeq: lf.turnSeq,
        text: assistantContent,
        toolCalls: Array.from(toolCallAccumulators.values())
          .filter((acc) => acc.id && acc.functionArguments)
          .map((acc) => ({
            id: acc.id,
            name: acc.functionName,
            arguments: acc.functionArguments,
          })),
        usage: lastUsage ?? {},
      },
      pipe,
    );

    // 内部使用埋点：每个 tool_use 意图一条 model_intent（fan-out）。
    stageEmitModelIntent({
      gates: ctx.gates,
      // 与 session_init_logs 对齐 compositeKey 形态
      sessionKey: `${ctx.agentSource}:${sessionKey}`,
      turnSeq: lf.turnSeq,
      spaceId: spaceId,
      userId: keyId,
      agentSource: ctx.agentSource,
      intents: Array.from(toolCallAccumulators.values())
        .filter((acc) => acc.functionName)
        .map((acc) => ({ name: acc.functionName, arguments: acc.functionArguments })),
    });

    if (lastUsage) {
      // 58e4c55b: token 记账 + usage log + opik span 保留在 usage 块内
      // (三者都需要 usage 数据); 下面的 langfuseReportGeneration 外移,
      // 让"上游 200 但没 usage chunk"的流也照常上报 generation。
      await stageRecordTokenUsage({
        config, gates: ctx.gates,
        isCustomUpstream: !!ctx.isCustomUpstream,
        spaceId, modelId, usage: lastUsage, protocol: "openai",
      });
      stageWriteUsageLog({
        config, gates: ctx.gates, pipe,
        timestamp: endTime, modelId, keyId, sessionKey,
        turnSeq: lf.turnSeq, userInput: lf.userQuery || undefined,
        upstreamUrl, usage: lastUsage, requestReceivedAt: startTime,
        extensionStats: ctx.preparedStats ?? undefined,
        logMeta: ctx.logMeta, routedFrom: ctx.routedFrom, spaceId, upstreamRequestId,
      });
      stageOpikStreamSpan({
        config, gates: ctx.gates, pipe,
        traceId, forkTraceId: ctx.forkTraceId, keyId, modelId,
        startTime, endTime, inputMessages, outputMessage,
        usage: lastUsage, retried, upstreamUrl,
        updateTrace: true, streamTag: "stream",
      });
    }

    if (!lastUsage) pipe.info("USAGE_MISSING", "stream completed without usage chunk");
    // Langfuse: report the completed turn even if the upstream omitted usage.
    // 流式路径 inputMessages 保持原样（其它下游流水线也用同一份引用）；
    // debug=true 时把 tool_call 累积计数塞进 metadata 兜底。
    try {
      const streamDebugExtra = ctx.langfuseDebug
        ? {
            stream_tool_call_count: toolCallAccumulators.size,
            stream_assistant_content_len: assistantContent.length,
          }
        : {};
      langfuseReportGeneration({
        traceId: lf.traceId,
        name: modelId,
        model: modelId,
        startTime,
        endTime,
        input: buildLangfuseInputChat(inputMessages, ctx.langfuseDebug, flattenMessagesForOpik),
        output: outputMessage,
        usage: lastUsage ?? undefined,
        traceName: lf.traceName,
        userId: lf.userId,
        sessionId: lf.sessionId,
        tags: lf.tags,
        traceInput: lf.userQuery || undefined,
        traceOutput: outputMessage ?? undefined,
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

    if (ctx.tdaiClient && isExtractionAllowed(ctx.config, "tdai-memory")) {
      // Streaming 不 await（会拖慢 SSE 关流体感），改成 trackWrite + 重试：
      //   - trackWrite 注册 in-flight promise 到全局 set；SIGTERM 时 index.ts 会
      //     flushPendingWrites 等待或超时兜底，避免 pod rolling 时丢 L0。
      //   - withL0Retry 应对 tdai kernel 瞬断 / 5xx（3 次退避 ~3.5s 总时长）。
      trackWrite(
        withL0Retry(() => recordTdaiTurn(
          ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage,
          outputMessageContent(outputMessage),
        )).catch((err: unknown) => pipe.error("TDAI_L0", err))
      );
    } else if (ctx.tdaiClient) {
      logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKeyForSkill);
    }

    pipe.streamDone(lastUsage);

    // Skill extract trigger — after stream finalization.
    // 同步 await：直到 store 落盘再继续，保证下一轮跨节点读到最新数据。
    // aux 请求(compaction/title)/dsh headless 跳过 skill 触发,保持归档 buffer 语义纯净。
    if (!ctx.isAuxiliary && !ctx.isDshHeadless && isExtractionAllowed(ctx.config, "skill")) {
      await triggerSkillExtractIfReady({
        config: ctx.config,
        sessionKey: ctx.sessionKeyForSkill,
        agentSource: ctx.agentSource,
        sessionInfo: ctx.sessionInfo,
        inputMessages: ctx.inputMessages,
        assistantMessage: outputMessage,
        protocol: "openai",
        assetCapabilities: ctx.assetCapabilities,
        toolCallCountOverride: toolCallAccumulators.size,
      });
    } else if (!ctx.isAuxiliary && !ctx.isDshHeadless) {
      logExtractionSkipped(ctx.config, "skill", ctx.sessionKeyForSkill);
    }

    // Credit usage reporting (streaming) via shared stageCredit — 客户端已收流,
    // 失败只能落日志和 CH raw (无法追加响应头)。
    if (ctx.gates?.creditReport !== false) {
      stageCredit({
        skipCreditReport: ctx.skipCreditReport,
        config: ctx.config,
        path: ctx.requestPath,
        usage: lastUsage,
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

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        processSseChunk(decoder.decode(chunk, { stream: true }));
      } catch (err: unknown) {
        pipe.error("STREAM_TAP", err);
      }
    },
    async flush() {
      try {
        await finalize();
      } catch (err: unknown) {
        pipe.error("STREAM_FINALIZE", err);
      }
    },
  });
}
