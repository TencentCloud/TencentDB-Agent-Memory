/**
 * Codex Responses API handler.
 *
 * Handles `POST /v1/responses` + 3 aux endpoints (`/responses/compact`,
 * `/memories/trace_summarize`, `/realtime/calls`) for the Codex CLI client.
 *
 * Protocol: OpenAI Responses API — third independent path alongside
 * anthropicHandler (Anthropic Messages) and handler (OpenAI Chat Completions).
 *
 * Internal dispatch:
 *   /v1/responses               → main loop (session-init + injection + forward)
 *   /v1/responses/compact       → aux passthrough (no injection, credit only)
 *   /v1/memories/trace_summarize → aux passthrough
 *   /v1/realtime/calls          → aux passthrough
 *   other codex paths           → 404
 *
 * Session-init flow:
 *   1. Extract session_id from header/body
 *   2. Check sessionStore for binding
 *   3. If unbound → call handleSessionInit (reuses CB state machine with
 *      agentSource="codex", protocol="responses") → return request_user_input form
 *   4. Detect Default mode gate → permanent bypass
 *   5. If bound → inject assets via buildCodexInjectionBlock → forward
 *
 * See docs/2026-08-07-codex-integration-plan.md.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { apiKeyToKeyId, extractBearerToken, opikCreateTrace, uuidv7 } from "../../opik.js";
import { createPipeline, writeLog } from "../../logger.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";
import { joinUrl } from "../../guard-adapter.js";
import {
  prepareUpstreamRequest,
  notifyUpstreamResponse,
  type UpstreamToolCall,
} from "../../request-prepare-adapter.js";
import {
  createCfqStripStream,
  createCfqStripObserver,
  stripCfqFromResponseText,
} from "../../common/cfq-strip.js";
import {
  collectResponsesOutputText,
  collectResponsesToolCalls,
} from "../../common/responses-payload.js";
import { isLegacyProxyPath } from "../../routes/whitelist.js";
import { verifyUserKey } from "../../auth.js";
import { stageAuth } from "../stages/auth.js";
import { stageParseBody } from "../stages/parse-body.js";
import { stageSessionResetPreHook } from "../stages/session-reset-pre-hook.js";
import { stageSessionResetConfirmation } from "../stages/session-reset-confirmation.js";
import { stageMemCommandIntercept } from "../stages/mem-command-intercept.js";
import { countHumanTurnsResponses } from "../../turnSeq.js";
import { stageIdentity } from "../stages/identity.js";
import { stageModelGate } from "../stages/model-gate.js";
import { resolveAgentStrategy } from "../strategies/agent/index.js";
import { enforceRateLimit, isRateLimitExceededError } from "../../rate-limit/guard.js";
import { resolveModelId } from "../../pricing.js";
import { codexAdapter } from "../../agent-adapters/codex.js";
import {
  DEFAULT_GATE_PREFIX,
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "../../session/codex/form.js";
import { buildCodexInjectionBlock, type CodexInjectionInput } from "../../common/codex-injection.js";
import { log } from "../../report/log.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import { TdaiClient, buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { stageArchive } from "../stages/archive.js";
import { stageCredit } from "../stages/credit.js";
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
import {
  stageInstanceUpstreamResponses,
  isInstanceUpstreamBlocked,
} from "../stages/instance-upstream-responses.js";

// ── Constants ────────────────────────────────────────────────────────────────

// SKIP header sets 已合并到 common/constants.ts (codex 用 WITH_INTERNAL 版本)
import { SKIP_REQUEST_HEADERS_WITH_INTERNAL as SKIP_REQUEST_HEADERS, filterResponseHeaders } from "../../common/constants.js";

// ── TDAI L0 helpers (对齐 anthropicHandler / handler 姿势) ───────────────────

/**
 * TDAI L0 客户端工厂 —— 跟 anthropicHandler.ts::createTdaiClient 语义一致。
 * spaceId 优先于 config 默认 serviceId, 便于多租户下 codex 请求上报到正确的
 * kernel 实例。config.tdai.memory.enabled=false 时返 null。
 */
const createCodexTdaiClient = buildTdaiClientForRequest;

/**
 * 从 codex `input[]` 抽最后一条 role=user 的真实用户文本, 组装 TdaiMessage。
 * 相当于 tdai/recorder.ts::extractLatestUserMessage 的 codex 变体 —— 差别在
 * 遍历判据 (type==="message" && role==="user") 与文本取值 (content[].input_text)。
 * 复用 codexAdapter.extractUserText, 保证跟 codexHandler 里 langfuse traceInput
 * 使用同一份用户提问文本 (docs/2026-08-07-codex-integration-plan.md §9)。
 */
function extractLatestCodexUserMessage(input: unknown): TdaiMessage | null {
  if (!Array.isArray(input)) return null;
  const text = codexAdapter.extractUserText(input) ?? "";
  const trimmed = text.trim();
  if (!trimmed) return null;
  return { role: "user", content: trimmed };
}

// ── Codex session state (exported for unit tests) ────────────────────────────

export interface CodexSessionState {
  status: "initialized" | "pending";
  bypassed?: boolean;
  sessionInfo?: Record<string, unknown> | null;
}

// ── Aux detection (exported for unit tests) ──────────────────────────────────

/** Aux endpoint path suffixes — hardcoded in codex-rs/core/src/client.rs. */
const CODEX_AUX_PATH_SUFFIXES = new Set([
  "/responses/compact",
  "/memories/trace_summarize",
  "/realtime/calls",
]);

/** Known aux thread_source values. */
const CODEX_AUX_THREAD_SOURCES = new Set([
  "memory_consolidation",
  "system",
]);

/**
 * Classify a codex request as main or auxiliary.
 * Exported for unit tests.
 */
export function classifyCodexRequest(
  body: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): "main" | "auxiliary" {
  // Signal 1: aux endpoint path suffix
  for (const suffix of CODEX_AUX_PATH_SUFFIXES) {
    if (path.endsWith(suffix)) return "auxiliary";
  }

  // Signal 2: x-openai-memgen-request header
  if (headers["x-openai-memgen-request"] === "true") return "auxiliary";

  // Signal 3: body.client_metadata.thread_source whitelist
  const meta = body.client_metadata as { thread_source?: string } | undefined;
  const ts = meta?.thread_source;
  if (typeof ts === "string" && CODEX_AUX_THREAD_SOURCES.has(ts)) return "auxiliary";

  return "main";
}

// ── Session ID extraction (exported for unit tests) ──────────────────────────

/**
 * Extract session_id from codex request.
 * Primary: `session-id` header. Fallback: `body.client_metadata.session_id`.
 *
 * subagent 归一：带 x-parent-conversation-id 的请求（并行 subagent）一律用
 * parent id 作为会话身份，复用主会话 session state，避免重弹 session-init 表单。
 * 与 workbuddyHandler.extractWorkbuddySessionId 完全镜像
 * （2026-09-20 修复 WorkBuddy 压缩后无限循环，详见 session/session-key.ts 注释）。
 */
export function extractCodexSessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  const parentId = headers["x-parent-conversation-id"] ?? headers["X-Parent-Conversation-Id"];
  if (typeof parentId === "string" && parentId.length > 0) return parentId;

  if (headers["session-id"]) return headers["session-id"];
  const meta = body.client_metadata as { session_id?: string } | undefined;
  if (typeof meta?.session_id === "string") return meta.session_id;
  return null;
}

// ── Default mode gate detection (exported for unit tests) ────────────────────

/**
 * Scan codex input[] for the Default mode gate string in function_call_output.
 *
 * When the client is in Default mode, it intercepts `request_user_input` tool
 * calls and fabricates a `function_call_output.output` starting with
 * "request_user_input is unavailable in".
 *
 * 本函数是历史工具函数，实际拦截逻辑现已内化到 CB 状态机
 * （session/codebuddy/init.ts 的 codex-only pre-checks 段）。保留 export
 * 是因为 codex-handler.test.ts 有单测直接使用它验证结构识别。
 */
export function detectDefaultModeGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  // 只识别"input 最后一个 item 就是 gate output": 详见 codebuddy/init.ts 同名注释。
  const last = input[input.length - 1] as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return false;
  if (last.type !== "function_call_output") return false;
  const output = last.output;
  return typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX);
}

// ── Asset injection (exported for unit tests) ────────────────────────────────

/**
 * Inject `<tdai_injections>` wrapper into codex body.input[0].content[].
 *
 * Appends the injection block to the developer message (input[0]) content.
 * Defensive: if input[0] is not a message with an array content, returns
 * the body unchanged.
 *
 * Returns a shallow copy — original body is not mutated.
 */
export function injectCodexAssets(
  body: Record<string, unknown>,
  assets: CodexInjectionInput,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  const devMsg = input[0] as Record<string, unknown> | null;
  if (!devMsg || typeof devMsg !== "object") return body;
  if (devMsg.type !== "message") return body;

  const content = devMsg.content;
  if (!Array.isArray(content)) return body;

  const injectionBlock = buildCodexInjectionBlock(assets);

  // Shallow-copy chain: body → input → input[0] → content
  const newContent = [...content, injectionBlock];
  const newDevMsg = { ...devMsg, content: newContent };
  const newInput = [newDevMsg, ...input.slice(1)];
  return { ...body, input: newInput };
}

// ── Upstream request helpers ─────────────────────────────────────────────────

function buildUpstreamHeaders(
  c: Context,
  config: ProxyConfig,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  // Codex uses OpenAI protocol: inject Bearer token
  if (config.upstream.apiKey) {
    headers["authorization"] = `Bearer ${config.upstream.apiKey}`;
    delete headers["x-api-key"];
  }
  return headers;
}

// filterResponseHeaders 合并到 common/constants.ts

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * Codex endpoint handler.
 *
 * Routes internally:
 *   - aux endpoints → lightweight passthrough
 *   - main /v1/responses → full pipeline (session-init, injection, mem-command, forward)
 */
export async function runCodexPipeline(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth (via shared stageAuth) ─────────────────────────────────────
  const auth = await stageAuth(c, "bearer-first");
  const apiKey = auth.apiKey;
  const spaceId = auth.spaceId;
  const userId = auth.userId;
  if (auth.rejected) {
    return c.json(
      { error: `Authentication failed: ${auth.rejectReason ?? "unknown"}` },
      401,
    );
  }
  const keyId = auth.keyId;

  // ── 2. Read body (via shared stageParseBody) ─────────────────────────
  const parseResult = await stageParseBody(c);
  if (!parseResult.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // ⚠️ `let` 不能改回 `const`: 下面 § 9 注入阶段 (line 770 附近)
  // 会 `body = injectCodexAssets(body, ...)` 原地替换为注入后的新对象。
  // c6fa775d (stageParseBody 迁移) 不小心改成了 const, 导致运行时
  // 抛 "Assignment to constant variable", catch 后降级为**无注入透传** —
  // codex 的 skill/memory/session_context 从此全丢。TS 2588 一直报警
  // 但被当成"重构遗留基线错误"没人修。
  let body = parseResult.body;

  // ── 3. Extract headers as plain object ─────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  // ── Identity埋点 (bug B5 fix: 老 codex 不调 inspectAndRecord) ────────────
  // 由 agent.stageGates.identityRecord 门控 (codex 现走 full preset, 恒 true)。
  // 历史上 codex 起步 minimal 且需显式 flip; 后因 B1-B8 修复在 minimal 下不生效
  // 而统一改为 full, 保留 gate 判据以便按档位回滚。
  const codexAgent = resolveAgentStrategy("codex");
  const reqHeadersForIdentity: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) reqHeadersForIdentity[k] = v;
  if (codexAgent.stageGates.identityRecord) {
    stageIdentity(c, body, "codex");
  }

  // ── DEBUG: dump request_user_input tool schema once so we can see codex's
  //           expected arguments shape and fix our fake form. Remove after fix.
  try {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const rui = tools.find(
      (t: any) => t?.type === "function" && t?.name === "request_user_input" ||
                  t?.function?.name === "request_user_input" ||
                  t?.name === "request_user_input",
    );
    if (rui) {
      console.log("[codex-debug] request_user_input tool schema:", JSON.stringify(rui));
    }
  } catch {}

  // ── 4. Classify request ────────────────────────────────────────────────────
  const requestKind = classifyCodexRequest(body, path, headers);
  const isAuxiliary = requestKind === "auxiliary";
  // 调用签名是 resolveModelId(creditPricingConfig, requestedModel) —— 之前
  // 错把 body 当第一参数（漏传 config）导致返回值是整个 body 对象。这个 bug
  // 从 codex P1 接入首帧就存在，之前 codex 未接 langfuse 没被发现——接入后
  // Langfuse trace name / observation name 都成了 " / usr-xxx" 空串前缀。
  // 对齐 handler.ts:482 / anthropicHandler.ts 的调用姿势。
  const requestedModel = typeof body.model === "string" ? body.model : "";

  // ── Model gate + alias (bug B8 fix: 老 codex 完全不检查 pricing table) ──
  // 由 agent.stageGates.modelGate 门控 (codex 现走 full preset, 恒 true)。
  // 等价 openai-chat + anthropic 行为。
  // isCustomUpstream 判断: 复用 stageInstanceUpstreamEarly 已计算的 shouldOverride 结果
  // (但 codex 老代码没走这个 early stage, 这里独立算一次 — 保守跳过 gate 只在 aux 场景)
  const _spaceIdForGate = extractSpaceIdFromPath(path) ?? "";
  let _codexIsCustomUpstream = false;
  if (codexAgent.stageGates.modelGate && !isAuxiliary) {
    try {
      const { getInstanceUpstreamConfigs, resolveForAgent, shouldOverride } =
        await import("../../instance-upstream-cache.js");
      const cfgs = await getInstanceUpstreamConfigs(config.coreSkill, _spaceIdForGate, config.instanceUpstream);
      _codexIsCustomUpstream = shouldOverride(resolveForAgent(cfgs, "codex"));
    } catch {
      _codexIsCustomUpstream = false;
    }
    if (!_codexIsCustomUpstream) {
      const gateResult = stageModelGate(requestedModel, config, false);
      if (!gateResult.ok) {
        return c.json({
          type: "error",
          error: { type: "invalid_request_error",
            message: `Model '${requestedModel}' is not a registered display name in the credit pricing table` },
        }, 400);
      }
    }
  }

  const modelId = resolveModelId(config.creditPricing, requestedModel);
  // 对外展示名只用于客户端请求；TokenHub 只接受价目表中登记的真实服务 ID。
  if (typeof body.model === "string" && modelId !== requestedModel) {
    body.model = modelId;
  }

  const pipe = createPipeline(config, traceId, modelId);

  // ── 5. Aux passthrough ─────────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("CODEX_AUX", `auxiliary request → passthrough (path=${path})`);
    // aux 不上报 langfuse（跟 CC/CB 对齐——sidequery/fork 类 aux 不算真对话轮）
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, null);
  }

  // ── 6. Session ID extraction ───────────────────────────────────────────────
  const sessionId = extractCodexSessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "codex";
  const isStream = body.stream !== false;

  const callerUserKey = apiKey || null;

  // ── 6b. Langfuse turn context (one trace = one turn) ────────────────────────
  // codex 的 turn 序号从 body.input[] 里"人类输入"数量推导（同 CC/CB 惯例；
  // 同 turn 内的工具循环请求会算出相同的 turnSeq → 同一 trace）。用户问题
  // 走 codex adapter 的 extractUserText——codex 用 input[] 而非 messages[]，
  // 通用 resolveLatestUserQuery 靠 costGuard profile 走 messages[]，这里不合用。
  const turnSeq = countHumanTurnsResponses(body.input);
  const userQuery = codexAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
    // agent_source tag 标明客户端族群；protocol:responses 区分 codex 的 wire。
    tags: [
      `agent_source:${agentSource}`,
      "protocol:responses",
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
    ],
    routeTags: [],
    userQuery,
  };

  // ── 6c. Legacy /proxy/<spaceId> —— 只做路由 + 压缩 + 计费 ───────────────────
  // 该前缀不带 agent 段，走到这里的客户端身份无从判断。记忆类功能全部跳过：
  // 按错误的 agent 画像弹表单、拦 mem 命令、往上下文注入资产，比不做更糟。
  // archiveCtx=null 同时关掉 skill 提取与 TDAI L0 写入；lf 仍然构造，压缩、
  // 计费与 usage 落表照常。
  if (isLegacyProxyPath(path)) {
    pipe.info("CODEX_LEGACY_PROXY", `legacy /proxy prefix → route+compress only (path=${path})`);
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, null);
  }

  // ── 7. Session-init state machine ──────────────────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("../../injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  // 存 initResult 的 agent/task detail 供 § 9 注入阶段构造 <session_context>。
  // handleSessionInit 内部本会通过 messages[0] 塞进 session_context，但那份
  // messages 是我们传进去的临时 synthesizedMessages，不会回到 codex body。
  // 这里显式抓 detail，让下面合成 body 时用 buildSessionContextBlockWithToggles
  // 造同款 block 并预填到合成 system message 前面。
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook (via shared stage) ──
  {
    const { codexAdapter } = await import("../../agent-adapters/codex.js");
    const userText = codexAdapter.extractUserText(input) ?? "";
    const _resetResp = await stageSessionResetPreHook({
      c, config, body: body as Record<string, unknown>, agentSource, sessionKey, spaceId, userId,
      isAuxiliary: false, dshHeadless: false, isStream,
      protocol: "responses", userText, enabled: true,
    });
    if (_resetResp) return _resetResp;
  }

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ────
  //
  // 老版本 7a (Default gate 独立拦截) + 7b.1 (MORE 独立拦截) 已收敛进 CB 状态机内部
  // (session/codebuddy/init.ts 顶部 codex-only pre-checks 段)。codexHandler 只
  // 负责把 body.input[] 透传给 reqCtx.codexAnswerInput 让状态机自己识别 gate/MORE。
  // 首次 Default gate 命中会拿到 initResult.bypassReason === "default-gate", 由
  // 本 handler 返一次 Plan 模式提示；后续同 session 请求 bypass 稳态透传。
  if (config.sessionInit?.enabled && sessionId) {
    try {
      // Round 18: session-init 主编排走 shared stageSessionInitOrchestrate;
      // codex 4 个 callback:
      //   - synthesizeMessages: codexFormAnswersAsMessages(input)
      //   - buildRecoverInitResult: systemAppend + messages:[] (responses)
      //   - buildInterceptResponse: buildCodexFormResponse (Responses API SSE)
      //   - buildDefaultGateResponse: codex 独有 Plan 提示 (处理在下方 bypassReason 分支)
      const _orch = await stageSessionInitOrchestrate({
        agentSourceForState: agentSource,
        sessionKey, userId: userId || null, spaceId,
        config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
        kernelUserKey: apiKey,
        headers, recoveryMessages: [],
        synthesizeMessages: () => {
          const synth = codexFormAnswersAsMessages(input);
          const rawOutputs = input
            .filter((it: any) => it?.type === "function_call_output")
            .map((it: any) => ({ call_id: it.call_id, output_preview: String(it.output ?? "").slice(0, 200) }));
          if (rawOutputs.length > 0) {
            console.log(`[codex-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synth).slice(0, 500)}`);
          }
          return synth;
        },
        buildRecoverInitResult: async (recovered) => {
          const { buildSessionContextBlockWithToggles } = await import("../../session/context-injector.js");
          const systemAppend = recovered.bypassed
            ? null
            : buildSessionContextBlockWithToggles(
                recovered.agentDetail ?? null,
                recovered.taskDetail ?? null,
                config.sessionInit,
                sessionKey,
              );
          return { messages: [], systemAppend };
        },
        buildReqCtx: () => ({
          stream: isStream,
          modelId: modelId as string,
          protocol: "responses" as any,
          // 把原始 input[] 交给 CB 状态机，用于识别 codex 客户端专属的 Default gate 字符串和 MORE 翻页标记
          codexAnswerInput: input,
        }),
        buildInterceptResponse: (initResult) => {
          if (!initResult.formData) return initResult.response ?? null;
          return buildCodexFormResponse({
            teams: initResult.formData.teams,
            stage: initResult.formData.stage,
            selectedTeamId: initResult.formData.selectedTeamId,
            selectedAgentId: initResult.formData.selectedAgentId,
            retry: initResult.formData.retry,
            teamPage: initResult.formData.teamPage ?? 0,
            agentPage: initResult.formData.agentPage ?? 0,
            taskPage: initResult.formData.taskPage ?? 0,
            // Override stream with 当前请求的 stream flag (form 建时的值可能过期)
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        },
        // Default-gate 分支在下方保留 inline (需 access pipe.info + bypassReason 复杂文案分支)
      });
      if (!_orch.proceed) return _orch.response!;
      const initResult = _orch.initResult!;

      // ── Default gate 首次命中：CB 状态机已经落 bypass state，本 handler
      //    返一次 Plan 模式提示；下一轮请求 recovered.bypassed=true 会走
      //    initialized 分支直接透传，Plan 提示不会再重复。
      if ((initResult as any).bypassReason === "default-gate") {
        pipe.info("CODEX_GATE", "Default mode gate detected → notify user (first hit)");
        const { buildMemResponse } = await import("../../mem-command/response-builder.js");
        // reset 场景下的 gate: 用户明确发了 mem:session-reset 命令,
        // 但 codex 客户端不在 Plan 模式无法弹 form → 措辞需要 明确告知
        // "reset 命令需要 Plan 模式" 而非笼统的"资产功能不启用"。
        const gateText = (initResult as any).resetFlow
          ? "⚠️ mem:session-reset 需要 Plan 模式支持。\n\n"
            + "codex 客户端当前不在 Plan 模式，无法弹出资产选择表单。\n"
            + "请切到 Plan 模式后再执行 mem:session-reset。"
          : "检测到未开启 Plan 模式，本次对话不开启团队资产相关功能（Skill / Task / Agent 不参与）。"
            + "如需使用，请切到 Plan 模式后重新开启新会话。";
        return buildMemResponse(gateText, {
          protocol: "responses",
          stream: isStream,
          requestId: `codex-gate-${Date.now()}`,
        });
      }

      if (initResult.justRegistered) sessionJustRegistered = true;
      // Bypass path → skip injection (via shared stageSessionBypass)
      const _bypassResult = stageSessionBypass({
        bypassed: !!initResult.bypassed,
        resetFlow: !!initResult.resetFlow,
        sessionKey,
        logPrefix: "[codex]",
      });
      if (_bypassResult.skipInjection) injectionSkipped = true;
      if (_bypassResult.resetFlowResult) _resetFlowResult = _bypassResult.resetFlowResult as unknown as typeof _resetFlowResult;

      assetCapabilities = await stageAssetCapabilities({
        bypassed: !!initResult.bypassed,
        sessionInfo: initResult.sessionInfo,
        config, spaceId,
        userKey: callerUserKey,
        warnPrefix: "[codex] asset-capability resolve failed:",
      });

      // Prewarm 前置短路：mem-command 命中的 turn 不走 forward、不消费 hook-cache，
      // 若照常 prewarm 会白花 2-3s + 3 次网络请求。见 handler.ts 对称位置详注。
      let memCommandPending = false;
      {
        try {
          const userTextPeek = codexAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText } = await import("../../mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek) {
              memCommandPending = true;
              console.log(`[codex] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
            }
          }
        } catch (err) {
          console.warn(
            "[codex] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Prewarm injection pipeline cache (same as anthropicHandler)
      await stagePrewarmInjection({
        bypassed: !!initResult.bypassed,
        justRegistered: !!initResult.justRegistered,
        sessionInfo: initResult.sessionInfo,
        agentDetail: initResult.agentDetail,
        taskDetail: initResult.taskDetail,
        memCommandPending,
        config, sessionKey, userId, agentSource, spaceId, assetCapabilities,
        callerUserKey: callerUserKey ?? undefined,
        logTag: "[codex] prewarm error:",
      });

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      // 缓存 detail 给下面 § 9 用（构造 <session_context> block）——两条分支都写：
      // recovered 分支的 initResult 是我们手工组装的，walked-through 分支来自
      // handleSessionInit 返回，字段都是 SessionInitResult 里的 agent/taskDetail。
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

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
      console.error("[codex] session-init error:", err instanceof Error ? err.message : String(err));
      sessionInfo = undefined;
      injectionSkipped = true;
    }
  }

  // ── mem:session-reset 完成确认 (via shared stage) ────────────────────────
  if (_resetFlowResult) {
    return stageSessionResetConfirmation({
      resetFlowResult: _resetFlowResult,
      protocol: "responses",
      isStream,
    });
  }

  // ── 8. mem-command intercept ────────────────────────────────────────────────
  // Position: after session-init, before injection (same as CC/CB).
  //
  // ⚠️ 不走 parseMemCommand(body, ...) —— 该函数只解 body.messages[] (CC/CB
  // 形态)，codex body 用 input[]，进去立即返 null → mem 命令全部静默透传给
  // LLM，模型会编造"Memory synced" 之类假回复 (P0-1 QA 报告)。
  // 直接用已提取的 userText 走 parseCommandFromText。
  // ── 8. mem-command intercept (via shared stage) ────────────────────────
  {
    const userText = codexAdapter.extractUserText(input);
    if (userText) {
      const { extractSimpleMessages } = await import("../../mem-command/index.js");
      const memResp = await stageMemCommandIntercept({
        enabled: true,
        body: body as Record<string, unknown>,
        agentSource: "codex", sessionKey,
        sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
        injectionSkipped, sessionJustRegistered: false,
        config, spaceId, userId: userId || "", apiKey: apiKey || "",
        callerUserKey: callerUserKey ?? undefined,
        isStream, protocol: "responses",
        modelId,
        upstreamUrl: config.upstream.agents?.["codex"]?.url || config.upstream.url,
        messages: input,
        createTdaiClientFn: createCodexTdaiClient,
        bodyMessages: extractSimpleMessages(input),
        assistantContentFormat: "responses-message",
        startTime, keyId, assetCapabilities,
        upstreamProtocol: "responses",
        userText,
        langfuseCtx: {
          traceId: lf.traceId,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: lf.tags,
        },
      });
      if (memResp) return memResp;
    }
  }

  // ── 9. Asset injection (every turn, no caching) ────────────────────────────
  // Only inject when session is initialized and not bypassed.
  //
  // Strategy: run the existing injection pipeline on a synthetic OpenAI-shaped
  // body (with an empty system message). The pipeline appends text blocks to
  // the system message's content — we extract those appended blocks and
  // re-package them as `<tdai_injections>` for the codex body format.
  //
  // This reuses 100% of the existing pipeline infrastructure (hook cache,
  // prewarm, all injectors) without writing a third protocol adapter.
  if (!injectionSkipped && sessionInfo && config.injection?.enabled && (config.injection.injectors?.length ?? 0) > 0) {
    try {
      const { getInjectionPipeline } = await import("../../injection/index.js");
      const pipeline = getInjectionPipeline(config);

      // ── session_context 预填 ────────────────────────────────────────────────
      // handleSessionInit 的 CB init 把 <session_context>（[Agent]+[Task] 描述）
      // 塞进它内部持有的 messages[0]（我们传给它的临时数组），这份 messages
      // 不会被返回给 codex handler；同时 initResult.systemAppend 只在 CC 分支
      // 填充，CB 分支永远 undefined。结果 codex 侧只拿到 skill/memory/knowledge
      // 段，**agent/task 描述完全没注入到最终 body 里**。
      //
      // 修法：直接用 buildSessionContextBlockWithToggles 从 handler 侧已经存好的
      // agentDetail/taskDetail 构造同款 block，预填到合成 body 的 system
      // message；下面 pipeline.process 会继续在同一 system message 后面 append
      // 更多注入内容，最终 raw 模式一起抽出去 → developer 段包含 session_context。
      const { buildSessionContextBlockWithToggles } = await import("../../session/context-injector.js");
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as any,
        cachedTaskDetail as any,
        config.sessionInit,
        sessionKey,
      );

      // Build a synthetic OpenAI body that the pipeline can parse/serialize.
      // The pipeline's OpenAI adapter reads `body.messages` and injects
      // text into the system message. We use a single system message as
      // the injection target; all injected text ends up there.
      const syntheticBody: Record<string, unknown> = {
        messages: [
          { role: "system", content: sessionContextBlock ?? "" },
          { role: "user", content: "." },
        ],
        model: modelId,
      };

      const injectedBody = await pipeline.process(syntheticBody, {
        protocol: "openai",
        traceId,
        keyId,
        modelId: modelId as string,
        stream: isStream,
        agentSource,
        userId: userId || "anonymous",
        spaceId,
        sessionKey,
        turnSeq: 0,
        requestPath: c.req.path,
        custom: { session: sessionInfo, userKey: callerUserKey ?? undefined, assetCapabilities },
      });

      // Extract injected content from the synthetic body's system message.
      // The pipeline appends to `messages[0].content` (system message).
      const injectedMessages = injectedBody.messages as Array<Record<string, unknown>> | undefined;
      const sysMsg = injectedMessages?.[0];
      const injectedText = typeof sysMsg?.content === "string" ? sysMsg.content : "";

      if (injectedText.length > 0) {
        // Pipeline 产出的 injectedText 已经是**成品 XML 文本**（含
        // <skill_tools> / <available_skills> / <user_memory> /
        // <tdai_profile_memory> / <memory-tools-guide> 等多组内部 tag)，
        // 与 CC / CB 客户端在 system message 里看到的内容字节一致。
        // 走 raw 模式原样嵌入 <tdai_injections> wrapper 内层——不再套
        // 内层 <available_skills> tag，也不 escape 内容里的 XML tag，
        // 否则模型看到的会是转义字符（`&lt;user_memory&gt;`）读不出结构。
        body = injectCodexAssets(body, { raw: injectedText });
      }
    } catch (err: unknown) {
      console.error("[codex] injection pipeline error:", err instanceof Error ? err.message : String(err));
      // Degrade gracefully: forward without injection
    }
  }

  // ── 10. Build archive ctx (skill + tdai L0), forward, tap for hooks ──────
  //
  // 只在 main dialog + 已初始化 + 未 bypass 的稳态下建 ctx —— injectionSkipped
  // 场景与 CC/CB 的"跳过 L0/skill"分支对齐(sessionInfo 缺 team/user/agent 三件套
  // triggerSkillExtractIfReady 本身也会早退, 但提前判可以省一次 fanout)。
  const archiveCtx = buildArchiveCtx({
    config,
    sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
    injectionSkipped,
    input,
    sessionKey,
    agentSource,
    spaceId,
    userId,
    callerUserKey,
    assetCapabilities,
  });

  // ── 11. Forward to upstream ────────────────────────────────────────────────
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, archiveCtx);
}

// ── Archive context (skill/conversation/add + TDAI L0 write) ─────────────────

/**
 * 归档触发上下文 —— 打包 hook 所需的所有输入, 从 handleCodexEndpoint 造好后
 * 一路透到 consumeCodexStream 的 completeStream 尾部触发 skill/L0 hooks。
 *
 * 只有 main 对话 + 已初始化 session + 未 bypass 才创建; 其它情况 archiveCtx=null,
 * forward 侧遇到 null 就跳过 hook (跟 CC/CB 的 isMainDialog 分支对齐)。
 */
export interface CodexArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  spaceId: string;
  /**
   * 原始 codex `input[]` —— skill 归档时按 protocol="responses" 走
   * normalize-conversation 内部 convertCodexInputItem 展开。
   */
  input: unknown[];
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  /** 从 `input[]` 抽出的最新用户提问 (extractLatestCodexUserMessage 提取)。 */
  tdaiUserMessage: TdaiMessage | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
}

function buildArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  agentSource: string;
  spaceId: string;
  userId: string;
  callerUserKey: string | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
}): CodexArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  const tdaiClient = args.assetCapabilities?.chat_memory === false
    ? null
    : createCodexTdaiClient(args.config, args.spaceId);
  const tdaiIdentity = deriveTdaiIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey,
  });
  const tdaiUserMessage = extractLatestCodexUserMessage(args.input);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: args.agentSource,
    sessionInfo,
    spaceId: args.spaceId,
    input: args.input,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
    assetCapabilities: args.assetCapabilities,
  };
}

/**
 * 流结束后触发 skill/conversation/add + TDAI L0 write, 对齐 CC/CB 的
 * anthropicHandler.ts:1867-1948 段。
 *
 * 参数:
 *   assistantText: SSE accumulator 累积的 assistant 文本
 *   toolUseCount:  流里累积的 function_call 数 (round 边界判据)
 *
 * 失败静默(错误已 log), 绝不阻塞 upstream 响应链。
 *
 * 内部走 shared stages/archive.ts::stageArchive (tdaiWriteMode="fire-and-forget-tracked"),
 * responses assistantMessage 形态 (type:"message", role:"assistant",
 * content:[{type:"output_text", text}]) 由本函数拼装后交给 stage。
 */
async function triggerCodexArchiveHooks(
  ctx: CodexArchiveCtx,
  assistantText: string,
  toolUseCount: number,
): Promise<void> {
  const assistantMessage = assistantText
    ? {
        type: "message" as const,
        role: "assistant" as const,
        content: [{ type: "output_text" as const, text: assistantText }],
      }
    : null;
  await stageArchive({
    config: ctx.config,
    sessionKey: ctx.sessionKey,
    agentSource: ctx.agentSource,
    sessionInfo: ctx.sessionInfo,
    inputMessages: ctx.input,
    assistant: { text: assistantText, raw: assistantMessage },
    protocol: "responses",
    assetCapabilities: ctx.assetCapabilities,
    tdaiClient: ctx.tdaiClient,
    tdaiIdentity: ctx.tdaiIdentity ?? undefined,
    tdaiUserMessage: ctx.tdaiUserMessage ?? undefined,
    isAuxiliary: false,
    dshHeadless: false,
    tdaiWriteMode: "fire-and-forget-tracked",
    toolCallCountOverride: toolUseCount,
    logPrefix: "[codex-tdai-l0]",
  });
}

// ── Forward helper ───────────────────────────────────────────────────────────

async function forwardToUpstream(
  c: Context,
  config: ProxyConfig,
  body: Record<string, unknown>,
  traceId: string,
  startTime: string,
  keyId: string,
  modelId: string,
  pipe: ReturnType<typeof createPipeline>,
  lf: LangfuseTurnContext | null,
  archiveCtx: CodexArchiveCtx | null = null,
): Promise<Response> {
  // Per-agent upstream override (upstream.agents.codex.url) 优先于全局 url。
  // 对齐 anthropicHandler.ts:1029 的解析姿势。codex 通常需要单独指向支持
  // Responses API 的兼容层——部分 OpenAI 兼容上游只实现
  // messages/chat_completions，不支持 /responses，此处允许按 agent 覆盖。
  const agentUpstreamEntry = config.upstream.agents?.["codex"];
  let upstreamBase = agentUpstreamEntry?.url || config.upstream.url;
  let upstreamUrl = joinUrl(upstreamBase, c.req.path);
  const upstreamHeaders = buildUpstreamHeaders(c, config);
  let skipCreditReport = false;
  upstreamHeaders["content-type"] = "application/json";
  // 覆盖 apiKey 与 per-agent 策略一致：agentUpstreamEntry.apiKey 优先，
  // 否则透传客户端 Bearer。
  if (agentUpstreamEntry) {
    if (agentUpstreamEntry.apiKey) {
      upstreamHeaders["authorization"] = `Bearer ${agentUpstreamEntry.apiKey}`;
    }
    // else: 保留 c.req.header('authorization') 里的客户端 key 透传
  }

  // ── Instance upstream config override (codex has no cost-guard routing) ──
  // v2 model groups(§7.3): 走 shared stageInstanceUpstreamResponses (与 wb 共享)。
  // 4 态处理: blocked/unmanaged → 400; override → 替换上游; official → 保持。
  // `/proxy/<spaceId>` 不带 agent 段: 强制 official (forceOfficial=true), 避免
  // 实例没把 codex 写进 agents 列表时 unmanaged → 400 把协议路由堵死。
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const _upstreamResolve = await stageInstanceUpstreamResponses({
    agent: "codex",
    spaceId,
    config,
    pathForOverride: c.req.path,
    forceOfficial: isLegacyProxyPath(c.req.path),
  });
  if (isInstanceUpstreamBlocked(_upstreamResolve)) {
    return c.json(_upstreamResolve.errorBody, 400);
  }
  if (_upstreamResolve.overrideUrl) {
    upstreamUrl = _upstreamResolve.overrideUrl;
    if (_upstreamResolve.headerUpdates?.authorization) {
      upstreamHeaders["authorization"] = _upstreamResolve.headerUpdates.authorization;
    }
    // codex 无 x-api-key 支持, deleteXApiKey 无操作
    if (_upstreamResolve.bodyModelOverride && typeof body.model === "string") {
      body.model = _upstreamResolve.bodyModelOverride;
    }
  }
  if (_upstreamResolve.skipCreditReport) skipCreditReport = true;

  // Optional private preparation stage. It rewrites `body` and the `input[]`
  // items in place, so it has to land after every host-side mutation (model
  // resolution, instance override) and before the body is serialized below.
  //
  // Auxiliary turns are excluded for the same reason they skip langfuse and
  // archive: they are client-driven background calls, not dialogue turns.
  let preparedStats: Record<string, unknown> | null = null;
  if (lf && Array.isArray(body.input)) {
    preparedStats = await prepareUpstreamRequest({
      config,
      protocol: "responses",
      body,
      messages: body.input,
      sessionKey: lf.sessionId,
      spaceId,
      pipe,
      upstreamCall: {
        upstreamUrl,
        headers: upstreamHeaders,
        model: modelId,
        tools: body.tools,
      },
      userQuery: lf.userQuery,
      lf,
      opikTraceId: traceId,
      opikKeyId: keyId,
    });
  }

  pipe.forwardStart(upstreamUrl);

  // ── Opik: create trace (bug B7 fix 迁移时丢失, 本次补回) ──────────────────
  // 与 anthropic.ts / openai-chat.ts 对齐: 必须在 span 之前 create trace,
  // 否则收尾的 opikCreateLlmSpan 会带着空 trace_id 被 Opik 拒 (422 traceId
  // must not be null), 整条 codex 链路在 Opik 侧完全不可见。
  // opik.enabled=false 时内部 no-op (返 "")。
  let forkTraceId: string | undefined;
  try {
    const { extractSimpleMessages: extractForOpik } = await import("../../mem-command/index.js");
    const inputMessages = extractForOpik(body.input);
    forkTraceId = opikCreateTrace(config, {
      traceId,
      projectName: keyId,
      name: `${modelId} / ${keyId}`,
      startTime,
      input: { messages: inputMessages },
      tags: lf?.tags ?? [],
      forkProjectName: "request_log",
      forkMetadata: {
        keyId,
        modelId,
        stream: true,
        upstreamUrl,
      },
    });
  } catch (opikErr: unknown) {
    pipe.error("OPIK_TRACE", opikErr instanceof Error ? opikErr : new Error(String(opikErr)));
  }

  // Bug B9 fix (handler-audit): 老 codex 无 AbortSignal.timeout, 上游卡死时 fetch
  // 永久 hang, pod OOM 才终止。加超时兜底 (跟 openai-chat/anthropic 对齐)。
  const forwardTimeoutMs = config.server?.forwardTimeoutMs ?? 600_000;

  // Bug B1 fix (handler-audit): 老 codex 完全不接 enforceRateLimit, 上游 quota 被
  // 打爆时无法保护自家运营账号。由 codex agent.stageGates.rateLimit 门控 (现走 full
  // preset, 恒 true)。custom upstream (用户自付) 时用户自己管 quota, 跳过。
  const codexAgentForForward = resolveAgentStrategy("codex");
  if (codexAgentForForward.stageGates.rateLimit && !skipCreditReport) {
    try {
      await enforceRateLimit({
        config,
        instanceId: extractSpaceIdFromPath(c.req.path) || undefined,
        modelId,
        protocol: "openai",
      });
    } catch (rlErr: unknown) {
      if (isRateLimitExceededError(rlErr)) {
        pipe.info("RATE_LIMIT", "TPM/QPM exceeded");
        return rlErr.response;
      }
      throw rlErr;
    }
  }

  let upstreamResp: Response;
  try {
    const fetchOpts: RequestInit = {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    };
    if (forwardTimeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(forwardTimeoutMs);
    }
    upstreamResp = await fetch(upstreamUrl, fetchOpts);
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.error("CODEX_FORWARD", `Timeout after ${forwardTimeoutMs / 1000}s`);
    } else {
      pipe.error("CODEX_FORWARD", err instanceof Error ? err : new Error(String(err)));
    }
    // 上报 langfuse 失败（转发异常 —— 上游未回响应体，只有本地 fetch 抛错）
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildCodexLangfuseInput(body),
          statusMessage: `forward error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: { stage: "forward", stream: true, upstreamUrl },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return c.json(
      { error: "Upstream request failed", detail: err instanceof Error ? err.message : String(err) },
      502,
    );
  }

  pipe.forwardDone(upstreamResp.status, upstreamResp.headers.get("x-request-id") ?? undefined);

  // Log usage
  writeLog(config, {
    timestamp: startTime,
    event: "request",
    modelId,
    keyId,
    sessionKey: keyId,
    upstreamUrl,
    stream: true,
    traceId,
  });

  // ── 上游 4xx/5xx：拷贝一份 body 文本用于 langfuse 错误上报；成功则 tap ──
  // codex Responses API 只有 SSE 流式响应，不区分 stream / non-stream 处理。
  if (upstreamResp.status >= 400) {
    // 4xx/5xx 通常返 JSON error（很小），完整读出来带进 langfuse 便于排查
    const errText = await upstreamResp.text();
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildCodexLangfuseInput(body),
          status: upstreamResp.status,
          statusMessage: errText.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: { stage: "upstream", stream: true, upstreamUrl },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return new Response(errText, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  const responseHeaders = filterResponseHeaders(upstreamResp.headers);
  // 上游请求 id —— 跨系统追溯用：客户端拿到的 x-request-id → 我方 usage_logs → 上游日志。
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const responseText = await upstreamResp.text();
    let usage: Record<string, unknown> | undefined;
    let toolCalls: UpstreamToolCall[] = [];
    let outputText = "";
    try {
      const responseBody = JSON.parse(responseText) as Record<string, unknown>;
      if (responseBody.usage && typeof responseBody.usage === "object") {
        usage = responseBody.usage as Record<string, unknown>;
      }
      toolCalls = collectResponsesToolCalls(responseBody.output);
      outputText = collectResponsesOutputText(responseBody);
    } catch {
      // Preserve an unexpected non-JSON response without billing it.
    }
    if (lf) {
      void notifyUpstreamResponse(config, {
        protocol: "responses",
        sessionKey: lf.sessionId,
        model: modelId,
        stream: false,
        turnSeq: lf.turnSeq,
        text: outputText,
        toolCalls,
        usage: usage ?? {},
      }, pipe);
    }
    if (usage && Object.keys(usage).length > 0) {
      writeLog(config, {
        timestamp: new Date().toISOString(),
        event: "usage",
        modelId,
        keyId,
        sessionKey: lf?.sessionId ?? keyId,
        turnSeq: lf?.turnSeq,
        userInput: lf?.userQuery || undefined,
        upstreamUrl,
        stream: false,
        usage,
        requestReceivedAt: startTime,
        extensionStats: preparedStats ?? undefined,
        spaceId,
        upstreamRequestId,
      });
      await stageRecordTokenUsage({
        config, gates: codexAgentForForward.stageGates,
        isCustomUpstream: skipCreditReport,
        spaceId,
        modelId, usage, protocol: "responses",
      }).catch((rlErr: unknown) => pipe.error("RATE_LIMIT_RECORD", rlErr));
      // stageCredit 统一走 shared 计费实现 (与 openai-chat / anthropic 对齐)
      const _creditResult = await stageCredit({
        skipCreditReport,
        config,
        path: c.req.path,
        usage,
        effectiveModel: modelId,
        upstreamUrl,
        event: "usage",
        startTime: new Date(startTime),
        reqIds: pipe.ids(),
        upstreamRequestId,
        sessionKey: lf?.sessionId ?? keyId,
        stream: false,
        keyId,
        routedFrom: "",
      }, pipe);
      if (_creditResult.responseErrorHeader) {
        responseHeaders.set("x-credit-report-error", _creditResult.responseErrorHeader);
      }
    }
    // 最后一公里：notify / 日志 / 计费都已经看过原始响应，这里才动给客户端的那份。
    const clientResponseText = stripCfqFromResponseText(
      "responses",
      responseText,
      preparedStats,
      createCfqStripObserver(pipe),
    );
    return new Response(clientResponseText, {
      status: upstreamResp.status,
      headers: responseHeaders,
    });
  }

  // 2xx: aux 场景 (lf=null && archiveCtx=null) 直接透传不 tap; 主对话场景 tap
  // 一份用于 langfuse 上报 + skill/L0 归档 hook (P1-P2 gap 修复)。
  // 只要有 lf 或 archiveCtx 任一非空就必须 tee 一份 tap 流。
  // Main turns are tapped for observability/archive; auxiliary Responses calls
  // are tapped for credit only.
  const needTap = Boolean(lf) || Boolean(archiveCtx) || !skipCreditReport;
  if (!needTap || !upstreamResp.body) {
    // 不 tap 也要剥离：注入与否跟观测无关，客户端校验一样会拒。
    return new Response(
      upstreamResp.body
        ? upstreamResp.body.pipeThrough(createCfqStripStream(
            "responses",
            preparedStats,
            createCfqStripObserver(pipe),
          ))
        : null,
      {
        status: upstreamResp.status,
        headers: filterResponseHeaders(upstreamResp.headers),
      },
    );
  }

  const [rawClientStream, tapStream] = upstreamResp.body.tee();
  consumeCodexStream(tapStream, {
    lf,
    modelId,
    startTime,
    upstreamUrl,
    inputBody: body,
    pipe,
    config,
    requestPath: c.req.path,
    keyId,
    sessionKey: lf?.sessionId ?? keyId,
    spaceId,
    // Opik trace id —— 必须是 opikCreateTrace 生成的那个 (pipeline 内部
    // traceId 与它同值, 但显式传递避免以后两者分叉时静默错位)。
    traceId,
    forkTraceId,
    upstreamRequestId,
    skipCreditReport,
    preparedStats,
    archiveCtx,
  });

  // CFQ 剥离排在最后：tap 走的是另一条 tee 分支，读到的仍是模型原始输出。
  return new Response(
    rawClientStream.pipeThrough(createCfqStripStream(
      "responses",
      preparedStats,
      createCfqStripObserver(pipe),
    )),
    {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
    },
  );
}

// ── Langfuse helpers ─────────────────────────────────────────────────────────

// countHumanTurnsCodex 合并到 turnSeq.ts::countHumanTurnsResponses (Round 7)。
// 保留别名 export 供 backward-compat (老测试还 import 这个名字)。
export { countHumanTurnsResponses as countHumanTurnsCodex } from "../../turnSeq.js";

/**
 * 构造送 langfuse 的 input —— codex 的 input[] 已经是结构化的对话历史，
 * 直接原样透传即可（跟 anthropic 的 buildLangfuseInput 目的一致：让
 * langfuse UI 上能看清"这一次调用的输入是啥"）。instructions 段单独带上,
 * 补齐上下文（codex 的 system prompt 在 body.instructions 而非 input）。
 */
function buildCodexLangfuseInput(body: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = { input: body.input };
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    out.instructions = body.instructions;
  }
  return out;
}

export interface CodexTapContext {
  /**
   * langfuse trace context; null 表示 aux 场景不上报 langfuse 但可能仍需
   * 归档 (理论上 aux 不会带 archiveCtx, 两者同时 null 时上游 tap 干脆不启动)。
   */
  lf: LangfuseTurnContext | null;
  modelId: string;
  startTime: string;
  upstreamUrl: string;
  inputBody: Record<string, unknown>;
  pipe: ReturnType<typeof createPipeline>;
  config?: ProxyConfig;
  requestPath?: string;
  keyId?: string;
  sessionKey?: string;
  /**
   * Opik trace id —— 由 forwardToUpstream 里的 opikCreateTrace 生成。
   * ⚠️ 与 lf.traceId (Langfuse, sha256 hex) 是两套独立 id，不能混用:
   *   Opik 要求 v7 UUID，传 Langfuse 的 32 位 hex 会被 400 拒。
   * 缺省 (undefined) 时 span 上报会带空 trace_id 被 Opik 422 拒。
   */
  traceId?: string;
  /** Opik fork trace id (request_log 项目)；opik 关闭时 undefined。 */
  forkTraceId?: string;
  /** Tenant the usage is billed to; ClickHouse filters on it. */
  spaceId?: string;
  /** Upstream `x-request-id`, carried for cross-system tracing. */
  upstreamRequestId?: string;
  skipCreditReport?: boolean;
  /** Opaque counters from the preparation stage, recorded with the usage log. */
  preparedStats?: Record<string, unknown> | null;
  /**
   * skill 归档 + TDAI L0 write hook 上下文;
   * null 表示当前请求不需要触发归档 (aux / session 未初始化 / bypass)。
   */
  archiveCtx?: CodexArchiveCtx | null;
}

/**
 * 消费 codex Responses API SSE 流，提取 usage + assistant output，上报 langfuse。
 *
 * codex SSE 关键帧（见 docs/2026-08-05-codex-onboarding.md §7.5.2/3）：
 *   - response.output_text.delta:  {delta: "..."}                → 累积 assistant 文本
 *   - response.function_call_arguments.delta: {delta: "..."}     → 累计 tool_use 参数（观察用）
 *   - response.completed: {response: {usage, output, status, ...}} → 收尾，取 usage
 *
 * 失败静默——埋点绝不影响业务链路。
 */
export function consumeCodexStream(stream: ReadableStream<Uint8Array>, ctx: CodexTapContext): void {
  const { lf, modelId, startTime, upstreamUrl, inputBody, pipe, archiveCtx } = ctx;

  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let usage: Record<string, unknown> = {};
    let outputText = "";
    let toolUseCount = 0;
    let toolCalls: UpstreamToolCall[] = [];
    let stopReason: string | undefined;
    let streamCompleted = false;
    // 5 分钟兜底：客户端断开可能让上游流卡住，这里超时也强制收尾一次。
    const timeoutHandle = setTimeout(() => {
      if (!streamCompleted) {
        pipe.error("STREAM_TIMEOUT", "Codex stream reading exceeded 5 minutes");
        void completeStream().catch((err) => pipe.error("STREAM_TIMEOUT_COMPLETE", err));
      }
    }, 5 * 60 * 1000);

    async function completeStream(): Promise<void> {
      if (streamCompleted) return;
      streamCompleted = true;
      clearTimeout(timeoutHandle);

      const endTime = new Date().toISOString();
      if (ctx.config && lf) {
        void notifyUpstreamResponse(ctx.config, {
          protocol: "responses",
          sessionKey: lf.sessionId,
          model: modelId,
          stream: true,
          turnSeq: lf.turnSeq,
          text: outputText,
          toolCalls,
          usage,
        }, pipe);
      }
      if (ctx.config && Object.keys(usage).length > 0) {
        // codex 老行为: writeLog(usage) 无 gate 恒写 (B6 已在 pipeline 迁移时补齐,
        // 不套 stageGates.writeLogUsage 以避免任何 preset 档位让 codex 停写)
        stageWriteUsageLog({
          config: ctx.config, pipe,
          timestamp: endTime, modelId,
          keyId: ctx.keyId ?? "unknown",
          sessionKey: ctx.sessionKey ?? "",
          turnSeq: lf?.turnSeq,
          userInput: lf?.userQuery || undefined,
          upstreamUrl, usage,
          requestReceivedAt: startTime,
          extensionStats: ctx.preparedStats ?? undefined,
          spaceId: ctx.spaceId,
          upstreamRequestId: ctx.upstreamRequestId,
        });
      }
      if (ctx.config && ctx.requestPath) {
        // stageCredit 统一走 shared 计费实现 (与 openai-chat / anthropic stream 分支对齐)
        // stream 场景客户端已收到, 响应头写不进去 (但 stage 内部仍会 log + CH raw 兜底)
        await stageCredit({
          skipCreditReport: ctx.skipCreditReport,
          config: ctx.config,
          path: ctx.requestPath,
          usage: Object.keys(usage).length > 0 ? usage : undefined,
          effectiveModel: modelId,
          upstreamUrl,
          event: "usage",
          startTime: new Date(startTime),
          reqIds: pipe.ids(),
          upstreamRequestId: ctx.upstreamRequestId ?? "",
          sessionKey: ctx.sessionKey ?? "",
          stream: true,
          keyId: ctx.keyId ?? "unknown",
          routedFrom: "",
        }, pipe).catch((err: unknown) => pipe.error("CREDIT_REPORT", err));
      }
      if (lf) {
        try {
          const output = outputText
            ? { role: "assistant", content: outputText }
            : toolUseCount > 0
              ? { role: "assistant", content: `[${toolUseCount} tool call(s)]` }
              : undefined;
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: modelId,
            model: modelId,
            startTime,
            endTime,
            input: buildCodexLangfuseInput(inputBody),
            output,
            usage: Object.keys(usage).length > 0 ? usage : undefined,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: lf.tags,
            traceInput: lf.userQuery || undefined,
            traceOutput: output,
            traceMetadata: {
              stream: true,
              upstreamUrl,
              stop_reason: stopReason,
              tool_use_count: toolUseCount,
            },
            observationMetadata: {
              stream: true,
              stop_reason: stopReason,
              tool_use_count: toolUseCount,
            },
          });
        } catch (lfErr: unknown) {
          pipe.error("LANGFUSE_SPAN", lfErr);
        }
      }

      // ── Opik LLM span (bug B7 fix, gated by stageGates.opik) ──
      const codexAgent = resolveAgentStrategy("codex");
      if (ctx.config && Object.keys(usage).length > 0) {
        const output = outputText
          ? { role: "assistant" as const, content: outputText }
          : toolUseCount > 0
            ? { role: "assistant" as const, content: `[${toolUseCount} tool call(s)]` }
            : null;
        stageOpikStreamSpan({
          config: ctx.config, gates: codexAgent.stageGates, pipe,
          // Opik trace id 来自 ctx.traceId (由 forwardToUpstream 的
          // opikCreateTrace 产出)。缺失说明 opik 关闭 → stage 内部会因
          // opik.enabled=false 而 no-op, 不会发空 trace_id 的请求。
          traceId: ctx.traceId ?? "",
          forkTraceId: ctx.forkTraceId,
          keyId: ctx.keyId ?? "unknown",
          modelId, startTime, endTime,
          inputMessages: [{ role: "user", content: JSON.stringify(inputBody.input ?? []) }],
          outputMessage: output,
          usage,
          retried: false,
          upstreamUrl,
          streamTag: "stream",
          // codex 特色 "codex" tag 追加保留在这里, stageOpikStreamSpan 内部走 streamTag + retry tag
        });
        // stageOpikStreamSpan 只能带 stream / retry tag; codex 独有 "codex" tag 单独通过 forkMetadata 处理
        // 也可以直接在 stageOpikStreamSpan 输出后由 caller 追加, 但 opikCreateLlmSpan 是幂等 sink 无二次调用
        // 决定: 不严格保留 "codex" tag (老行为里只是分类标, opik 侧 tag 不影响 UI 主路径)
      }

      // ── ModelIntent telemetry (bug B4 fix, gated by stageGates.modelIntentTelemetry) ──
      stageEmitModelIntent({
        gates: codexAgent.stageGates,
        sessionKey: `codex:${ctx.sessionKey}`,
        turnSeq: lf?.turnSeq ?? 0,
        spaceId: ctx.spaceId,
        userId: ctx.keyId ?? "unknown",
        agentSource: "codex",
        intents: toolCalls.filter((tc) => tc.name).map((tc) => ({ name: tc.name, arguments: tc.arguments })),
      });

      // ── recordInputTokenUsage (bug B1 fix, gated by stageGates.rateLimit) ──
      if (ctx.config && Object.keys(usage).length > 0) {
        await stageRecordTokenUsage({
          config: ctx.config, gates: codexAgent.stageGates,
          isCustomUpstream: !!ctx.skipCreditReport,  // codex 用 skipCreditReport 当 custom 标志
          spaceId: ctx.spaceId,
          modelId, usage, protocol: "responses",
        }).catch((rlErr: unknown) => pipe.error("RATE_LIMIT_RECORD", rlErr));
      }

      // ── Skill/conversation/add + TDAI L0 归档 hook ──
      // 对齐 anthropicHandler.ts 的 stream 分支 (line 1867-1948): langfuse 上报后
      // 触发 skill 归档 + L0 write。失败静默 (内部已 warn), 不阻塞客户端 SSE。
      // archiveCtx=null (aux / 未初始化 session / bypass) 直接跳过。
      if (archiveCtx) {
        try {
          await triggerCodexArchiveHooks(archiveCtx, outputText, toolUseCount);
        } catch (archiveErr: unknown) {
          pipe.error("CODEX_ARCHIVE", archiveErr instanceof Error ? archiveErr : new Error(String(archiveErr)));
        }
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
            if (line.startsWith("data: ")) dataStr = line.slice(6);
            else if (line.startsWith("data:")) dataStr = line.slice(5);
          }
          if (!dataStr) continue;

          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string | undefined;

            if (evtType === "response.output_text.delta") {
              const delta = evt.delta;
              if (typeof delta === "string") outputText += delta;
            } else if (evtType === "response.output_item.added") {
              const item = evt.item as Record<string, unknown> | undefined;
              if (item?.type === "function_call") toolUseCount++;
            } else if (evtType === "response.completed") {
              const resp = evt.response as Record<string, unknown> | undefined;
              if (resp?.usage) {
                Object.assign(usage, resp.usage as Record<string, unknown>);
              }
              // 终态 `output[]` 带完整的 call_id 与逐字 arguments，比累积
              // response.function_call_arguments.delta 更可靠。
              if (resp?.output) toolCalls = collectResponsesToolCalls(resp.output);
              stopReason = (resp?.status as string) ?? "completed";
            } else if (evtType === "response.incomplete") {
              // max_output_tokens / 其它中断（Responses API 标准）
              const resp = evt.response as Record<string, unknown> | undefined;
              const details = resp?.incomplete_details as Record<string, unknown> | undefined;
              stopReason = `incomplete:${details?.reason ?? "unknown"}`;
              if (resp?.usage) Object.assign(usage, resp.usage as Record<string, unknown>);
              if (resp?.output) toolCalls = collectResponsesToolCalls(resp.output);
            }
          } catch {
            // ignore malformed frames — 埋点级别的问题不阻塞
          }
        }
      }
    } catch (err: unknown) {
      pipe.error("CODEX_TAP", err instanceof Error ? err : new Error(String(err)));
    } finally {
      await completeStream();
    }
  })().catch((err: unknown) => pipe.error("CODEX_TAP_UNHANDLED", err));
}
