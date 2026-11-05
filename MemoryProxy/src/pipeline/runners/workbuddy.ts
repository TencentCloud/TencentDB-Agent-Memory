/**
 * WorkBuddy endpoint handler —— 骨架层（helper 函数 + main handler stub）。
 *
 * WorkBuddy 走 OpenAI Responses API（@openai/agents SDK），wire protocol 与
 * Codex一致，system prompt XML 结构与 CodeBuddy相似。但本文件**故意与
 * codexHandler / codebuddyHandler 完全解耦**，不import 任何 sibling handler，
 * 换WorkBuddy 只动本文件与 injection/agents/workbuddy/，其余客户端不受影响。
 *
 * 本轮（分层交付第一步）：**只暴露单测友好的 pure function**
 *   - classifyWorkbuddyRequest：识别 main vs auxiliary 请求
 *   - extractWorkbuddySessionId：从 header / body 中提取 session id
 *   - detectWorkbuddyDefaultModeGate：识别客户端 Default mode gate 信号
 *   - injectWorkbuddyAssets：向 body.input[0].content[] 追加 `<tdai_injections>` wrapper
 *
 * 完整的 `handleWorkbuddyEndpoint(c, config)` 主 handler（含 auth / session-init /
 * mem-command / forward+langfuse tap）留到下一轮 server 路由接入时再补——
 * 那部分需要引入大量 config/session 依赖，先隔离出来降低回归面。
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { buildSafeTraceRequestBody, writeRequestLog } from "../../requestLog.js";
import { logPipelineUpstreamError } from "../../upstream-error-log.js";
import { apiKeyToKeyId, extractBearerToken, opikCreateTrace, uuidv7 } from "../../opik.js";
import { createPipeline, writeLog } from "../../logger.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";
import { writeFailedReportRaw } from "../../clickhouse.js";
import { joinUrl } from "../../guard-adapter.js";
import { poolServiceRejection } from "../../pool-service.js";
import {
  prependNoticeToResponsesStream,
  prependNoticeToResponsesJson,
} from "./default-binding-notice.js";
import {
  stageInstanceUpstreamResponses,
  isInstanceUpstreamBlocked,
} from "../stages/instance-upstream-responses.js";
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
import { withStreamIdleWarning } from "../../common/stream-idle-watchdog.js";
import {
  collectResponsesOutputText,
  mergeResponsesToolCalls,
} from "../../common/responses-payload.js";
import { verifyUserKey } from "../../auth.js";
import { stageAuth } from "../stages/auth.js";
import { stageParseBody } from "../stages/parse-body.js";
import { stageSessionResetPreHook } from "../stages/session-reset-pre-hook.js";
import { stageSessionResetConfirmation } from "../stages/session-reset-confirmation.js";
import { stageMemCommandIntercept } from "../stages/mem-command-intercept.js";
import { countHumanTurnsResponses } from "../../turnSeq.js";
import { stageCredit } from "../stages/credit.js";
import { resolveModelId } from "../../pricing.js";
import { stageIdentity } from "../stages/identity.js";
import { stageModelGate } from "../stages/model-gate.js";
import { resolveAgentStrategy } from "../strategies/agent/index.js";
import { enforceRateLimit, isRateLimitExceededError } from "../../rate-limit/guard.js";
import { workbuddyAdapter } from "../../agent-adapters/workbuddy.js";
import {
  buildWorkbuddyInjectionBlock,
  type WorkbuddyInjectionInput,
} from "../../common/workbuddy-injection.js";
// WorkBuddy 走 Responses API，与 codex wire 完全一致 —— 弹窗骨架直接复用
// session/codex/form.ts 的 buildFormResponse + codexFormAnswersAsMessages，
// 状态机复用 CB 的 handleSessionInit(agentSource="codex")。这样 WorkBuddy
// 本身不需要单独做一套 form 骨架。
import {
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "../../session/codex/form.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";

// ── TDAI L0 + Skill extraction imports ────────────────────────────────────────
import { TdaiClient, buildTdaiClientForRequest } from "../../tdai/client.js";
import { deriveTdaiIdentity } from "../../tdai/identity.js";
import {
  ResponsesAssembler,
  buildSessionTurnContext,
  createSessionTurnSeed,
  parseSseData,
  responsesReplyFromJson,
  submitSessionTurn,
  type PendingSessionTurn,
  type SessionTurnContext,
} from "../../session-trace/index.js";
import type { TdaiIdentity, TdaiMessage } from "../../tdai/types.js";
import { stageArchive } from "../stages/archive.js";
import {
  stageWriteUsageLog,
  stageRecordTokenUsage,
  stageEmitModelIntent,
  stageOpikStreamSpan,
} from "../stages/stream-finalize.js";
import { stagePrewarmInjection } from "../stages/prewarm-injection.js";
import { stageAssetCapabilities } from "../stages/asset-capabilities.js";
import { stageTeamMemorySwitch } from "../stages/team-memory-switch.js";
import { stageSessionBypass } from "../stages/session-bypass.js";
import { stageSessionInitOrchestrate } from "../stages/session-init-orchestrate.js";
import { buildMemResponse } from "../../mem-command/response-builder.js";
import { hasExplicitAgentName, requireWecomIdentity } from "../../wecom-identity-form.js";

// ── Handler-level constants ──────────────────────────────────────────────────

// SKIP header sets 已合并到 common/constants.ts (workbuddy 用 WITH_INTERNAL 版本)
import { SKIP_REQUEST_HEADERS_WITH_INTERNAL as SKIP_REQUEST_HEADERS, filterResponseHeaders } from "../../common/constants.js";

// ── Types (exported for unit tests) ──────────────────────────────────────────

/**
 * WorkBuddy per-session state。
 * 与 CodexSessionState 语义一致但独立类型，避免跨 handler 类型共享。
 *
 * - status: "initialized" 表示已完成绑定/引导流程；"pending" 表示还在等
 *   session-init 表单回填
 * - bypassed: 用户明确选择"Default mode"绕过绑定流程后，永久跳过 form注入
 * - sessionInfo:绑定成功后附带的 { userId, teamId, agentId, ... } 元数据，
 *   透传给 injection pipeline 做上下文查询
 */
export interface WorkbuddySessionState {
  status: "initialized" | "pending";
  bypassed?: boolean;
  sessionInfo?: Record<string, unknown> | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * WorkBuddy 客户端 Default mode gate 的特征字符串。
 * 客户端在用户选 Default mode 后，会在 function_call_output 里输出这个前缀
 * 提示 "request_user_input is unavailable in Default mode"——命中即视为
 * 用户明确选择绕过绑定流程，session 应永久 bypass。
 *
 * WorkBuddy 客户端的实际字符串**待抓包验证**，本轮先按 codex 的 gate 字符串
 * 打（"request_user_input is unavailable in Default mode"），等真实客户端
 * 联调时对齐。
 * TODO(workbuddy-integration): 抓包确认 WorkBuddy 客户端实际的 gate 字符串。
 */
const DEFAULT_GATE_PREFIX = "request_user_input is unavailable in Default mode";

// ── Request classification ───────────────────────────────────────────────────

/**
 * Classify a WorkBuddy request as main or auxiliary.
 *
 * Auxiliary 请求指客户端自发的辅助调用（memory 生成、trace 汇总、compact
 * 等），不应触发 session-init form 或 injection，直接转发上游。
 *
 * 判定顺序（任一命中即返回 auxiliary）：
 *   1. path中出现 aux 路径片段（/compact, /trace_summarize, /realtime, /memories）
 *   2. header 出现 memgen 标记（x-openai-memgen-request=true，兼容 SDK 惯例）
 *   3. body.client_metadata.thread_source ∈ {system, memory_consolidation}
 *
 * 未知的 thread_source 视为 main（偏严——宁可漏 aux 也不误把用户交互当 aux）。
 */
export function classifyWorkbuddyRequest(
  body: Record<string, unknown>,
  path: string,
  headers: Record<string, string>,
): "main" | "auxiliary" {
  // ① path-based aux 判定
  const AUX_PATH_HINTS = ["/compact", "/trace_summarize", "/realtime", "/memories"];
  for (const hint of AUX_PATH_HINTS) {
    if (path.includes(hint)) return "auxiliary";
  }

  // ② header memgen 标记
  const memgen =
    headers["x-openai-memgen-request"] ??
    headers["X-OpenAI-Memgen-Request"] ??
    "";
  if (memgen === "true" || memgen === "1") return "auxiliary";

  // ③ body.client_metadata.thread_source
  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const ts = meta.thread_source;
    if (ts === "system" || ts === "memory_consolidation") return "auxiliary";
  }

  return "main";
}

// ── Session ID extraction ────────────────────────────────────────────────────

/**
 * 从请求头/请求体中提取 WorkBuddy session id。
 *
 * 优先级（与 codex 相同）：
 *   1. header `session-id`（SDK 默认位置）
 *   2. body.client_metadata.session_id（fallback）
 *
 * 两者都缺 → null（上层负责决定是拒绝还是生成新 session）。
 */
export function extractWorkbuddySessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
  // subagent 归一：带 x-parent-conversation-id 的请求（并行 subagent）一律用
  // parent id 作为会话身份，复用主会话 session state，避免重弹 session-init 表单
  // （2026-09-20 修复 WorkBuddy 压缩后无限循环，详见 session/session-key.ts 注释）。
  const parentId = headers["x-parent-conversation-id"] ?? headers["X-Parent-Conversation-Id"];
  if (typeof parentId === "string" && parentId.length > 0) return parentId;

  const fromHeader = headers["session-id"] ?? headers["Session-Id"] ?? headers["x-conversation-id"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;

  const meta = body.client_metadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const sid = meta.session_id;
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return null;
}

// ── Default mode gate detection ──────────────────────────────────────────────

/**
 * 识别 WorkBuddy 客户端的 Default mode gate 信号。
 *
 * 客户端在用户拒绝 request_user_input 表单（选择 Default mode）时，会在
 * 下一轮请求的 input[] 里带上 function_call_output.output ~= 
 * "request_user_input is unavailable in Default mode"。命中即表示用户
 * 明确要绕过绑定流程→ session 应标记 bypassed。
 *
 * 与 codex 版本同结构，字符串前缀独立定义（DEFAULT_GATE_PREFIX），未来客户端
 * 修改文案时只需改这一个常量。
 */
export function detectWorkbuddyDefaultModeGate(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call_output") continue;
    const output = it.output;
    if (typeof output === "string" && output.startsWith(DEFAULT_GATE_PREFIX)) {
      return true;
    }
  }
  return false;
}

// ── Asset injection ──────────────────────────────────────────────────────────

/**
 * Inject `<tdai_injections>` wrapper into WorkBuddy body.input[0].content[].
 *
 * 与 codex 逻辑同构：把 pipeline 产出的完整 XML 文本挂到 developer message
 * (input[0]) 的 content 数组末尾。
 *
 * 防御性 short-circuit：
 *   - 无 input 或 input 不是数组 → 返回原 body
 *   - input[0] 不是 message → 返回原 body
 *   - input[0].content 不是数组 → 返回原 body
 *   （这些防御分支的意义：客户端非首帧时 input[0] 可能是 function_call 之类，
 *    只有第一轮 input[0] 才是 developer/user message；错注入 function_call 项
 *    的 content 会导致上游 400 或语义错乱。）
 *
 * 返回浅拷贝，不修改原 body（body → input → input[0] → content 全链路浅拷）。
 */
export function injectWorkbuddyAssets(
  body: Record<string, unknown>,
  assets: WorkbuddyInjectionInput,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length === 0) return body;

  const devMsg = input[0] as Record<string, unknown> | null;
  if (!devMsg || typeof devMsg !== "object") return body;
  if (devMsg.type !== "message") return body;

  const content = devMsg.content;
  if (!Array.isArray(content)) return body;

  const injectionBlock = buildWorkbuddyInjectionBlock(assets);

  // Shallow-copy chain: body → input → input[0] → content
  const newContent = [...content, injectionBlock];
  const newDevMsg = { ...devMsg, content: newContent };
  const newInput = [newDevMsg, ...input.slice(1)];
  return { ...body, input: newInput };
}

// ── Human turn counting (langfuse 埋点辅助) ──────────────────────────────────

/**
 * 统计 WorkBuddy input[] 里的 "human turn" 数量。
 *
 * 用于 langfuse trace 的 turnSeq——只要客户端主动发出的用户消息（role=user
 * 且 type=message）参与计数；tool 调用产生的 function_call / function_call_output
 * / assistant 反馈不计入。这样同一轮内的多次 function_call 会merge 到同一个
 * trace，方便观测。
 *
 * 与 codex 的 countHumanTurnsCodex 同逻辑，为了保持"handler 之间零依赖"独立
 * 复制一份。
 */
// countHumanTurnsWorkbuddy 合并到 turnSeq.ts::countHumanTurnsResponses (Round 7)。
// 保留别名 export 供 backward-compat。
export { countHumanTurnsResponses as countHumanTurnsWorkbuddy } from "../../turnSeq.js";

// ── Workbuddy Archive Context (L0 write + Skill extract) ────────────────────

/**
 * WorkBuddy L0/Skill 归档上下文, 对齐 codexHandler 的 CodexArchiveCtx 设计:
 *   - archiveCtx=null 时 forward/session bypass 侧直接跳过 hook
 *   - 失败静默 (内部 warn), 绝不阻塞上游响应
 */
export interface WorkbuddyArchiveCtx {
  config: ProxyConfig;
  sessionKey: string;
  agentSource: string;
  sessionInfo: Record<string, unknown>;
  userId: string;
  /** 原始 body.input[] (responses API input items) */
  input: unknown[];
  tdaiClient: TdaiClient | null;
  tdaiIdentity: TdaiIdentity | null;
  tdaiUserMessage: TdaiMessage | null;
  /**
   * 资产能力开关（chat_memory / skill / ...）；用于 gate 归档 hook。
   * 与 codexHandler.CodexArchiveCtx.assetCapabilities 对齐。
   */
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
}

/**
 * 从 responses API body.input[] 提取 latest user message 用于 L0 write。
 */
function extractLatestWorkbuddyUserMessage(input: unknown): TdaiMessage | null {
  if (!Array.isArray(input)) return null;
  const text = workbuddyAdapter.extractUserText(input);
  if (!text) return null;
  return { role: "user", content: text };
}

// createWorkbuddyTdaiClient 老实现漏传 spaceId (bug: multi-tenant 时写错 tenant),
// 迁到 shared buildTdaiClientForRequest 自动修 — 老 wb call site 会补一个 spaceId 参数。
const createWorkbuddyTdaiClient = (config: ProxyConfig, spaceId?: string) =>
  buildTdaiClientForRequest(config, spaceId);

function buildWorkbuddyArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  userId: string;
  callerUserKey?: string | null;
  assetCapabilities?: import("../../injection/types.js").AssetCapabilityFlags;
}): WorkbuddyArchiveCtx | null {
  const { sessionInfo, injectionSkipped } = args;
  if (injectionSkipped || !sessionInfo) return null;

  // chat_memory=false 时用户显式关闭记忆 → 不创建 tdaiClient；skill 归档仍走。
  // 对齐 codexHandler.buildArchiveCtx (line 855-857)。
  const tdaiClient = args.assetCapabilities?.chat_memory === false
    ? null
    : createWorkbuddyTdaiClient(args.config);
  const tdaiIdentity = deriveTdaiIdentity({
    sessionInfo,
    userId: args.userId || null,
    sessionKey: args.sessionKey,
    userKey: args.callerUserKey ?? null,
  });
  const tdaiUserMessage = extractLatestWorkbuddyUserMessage(args.input);

  return {
    config: args.config,
    sessionKey: args.sessionKey,
    agentSource: "workbuddy",
    sessionInfo,
    userId: args.userId,
    input: args.input,
    tdaiClient,
    tdaiIdentity,
    tdaiUserMessage,
    assetCapabilities: args.assetCapabilities,
  };
}

/**
 * 流结束后触发 TDAI L0 write + skill 提取, 对齐 codexHandler 的
 * triggerCodexArchiveHooks 逻辑。失败静默(内部已 warn), 不阻塞下游。
 *
 * 内部走 shared stages/archive.ts::stageArchive (tdaiWriteMode="fire-and-forget-tracked"),
 * 与 codex archive hook 100% 对称, 仅 agentSource / logPrefix 参数不同。
 */
async function triggerWorkbuddyArchiveHooks(
  ctx: WorkbuddyArchiveCtx,
  assistantText: string,
  toolCallCountOverride?: number,
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
    agentSource: "workbuddy",
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
    toolCallCountOverride,
    logPrefix: "[workbuddy-tdai-l0]",
  });
}

// ── Upstream helpers ─────────────────────────────────────────────────────────

/**
 * 把 workbuddy 请求 body 结构化成 langfuse observation 的 `input` 字段。
 *
 * workbuddy 走 Responses API，请求体形态：
 *   - body.input:        Array<InputItem>（必有，用户消息 / 工具输出等）
 *   - body.instructions: string           （可选，system-level 指令）
 *
 * 组合策略（尽量减少 langfuse UI 嵌套层级）：
 *   - 有 instructions → 返回 { input, instructions }
 *   - 仅 input       → 直接返回 body.input
 *   - 都缺失         → 返回 undefined（langfuse 侧不写 input 字段）
 */
function buildWorkbuddyLangfuseInput(body: Record<string, unknown>): unknown {
  return buildSafeTraceRequestBody(body);
}

function buildUpstreamHeaders(c: Context, config: ProxyConfig): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS.has(k.toLowerCase())) h[k] = v;
  }
  if (config.upstream.apiKey) {
    h["authorization"] = `Bearer ${config.upstream.apiKey}`;
    delete h["x-api-key"];
  }
  return h;
}

// filterResponseHeaders 合并到 common/constants.ts

/**
 * Forward the request to upstream. On SSE responses with `lf != null`, tees
 * the stream and reports usage/text to langfuse (best-effort).
 */
async function forwardToUpstream(
  c: Context,
  config: ProxyConfig,
  body: Record<string, unknown>,
  traceId: string,
  startTime: string,
  keyId: string,
  obsProjectName: string,
  modelId: string,
  pipe: ReturnType<typeof createPipeline>,
  lf: LangfuseTurnContext | null,
  archiveCtx: WorkbuddyArchiveCtx | null = null,
  sessionTurn: PendingSessionTurn | null = null,
  /**
   * v3.3 user-session-default: 命中账户默认时, Proxy 在客户端响应最前面插的
   * ✅ 绑定提示文本(markdown)。null = 不插(非命中默认 / 后续轮次 / aux)。
   * 实现见 pipeline/runners/default-binding-notice.ts。
   */
  defaultBindingNotice: string | null = null,
): Promise<Response> {
  // ── Per-agent upstream override ──
  // 对齐 codexHandler: 支持 config.upstream.agents?.workbuddy 单独指 URL/apiKey，
  // 未配置时回退到全局 config.upstream.{url,apiKey}。
  const perAgent = (config.upstream as unknown as {
    agents?: { workbuddy?: { url?: string; apiKey?: string } };
  }).agents?.workbuddy;
  const upstreamBase = ((perAgent?.url ?? config.upstream.url ?? "") as string).replace(/\/$/, "");
  const upstreamPath = c.req.path.replace(/^\/workbuddy\/[^/]+/, "");
  let upstreamUrl = joinUrl(upstreamBase, upstreamPath);
  let skipCreditReport = false;

  const headers = buildUpstreamHeaders(c, config);
  // 若 per-agent 指定了独立 apiKey，覆盖全局注入的 authorization
  if (perAgent?.apiKey) {
    headers["authorization"] = `Bearer ${perAgent.apiKey}`;
    delete headers["x-api-key"];
  }

  // ── Instance upstream config override ──
  // v2 model groups(§7.3): 走 shared stageInstanceUpstreamResponses (与 codex 共享)。
  // pathForOverride 用剥去 /workbuddy/<sid> 前缀的 upstreamPath, 与老实现等价。
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";
  const _upstreamResolve = await stageInstanceUpstreamResponses({
    agent: "workbuddy",
    spaceId,
    config,
    pathForOverride: upstreamPath,
  });
  if (isInstanceUpstreamBlocked(_upstreamResolve)) {
    return c.json(_upstreamResolve.errorBody, 400);
  }
  if (_upstreamResolve.overrideUrl) {
    upstreamUrl = _upstreamResolve.overrideUrl;
    if (_upstreamResolve.headerUpdates?.authorization) {
      headers["authorization"] = _upstreamResolve.headerUpdates.authorization;
    }
    if (_upstreamResolve.headerUpdates?.deleteXApiKey) {
      delete headers["x-api-key"];
    }
    if (_upstreamResolve.bodyModelOverride && typeof body.model === "string") {
      body.model = _upstreamResolve.bodyModelOverride;
    }
  }
  if (_upstreamResolve.skipCreditReport) skipCreditReport = true;

  // Optional private preparation stage. It rewrites `body` and the `input[]`
  // items in place, so it has to land after every host-side mutation (model
  // resolution, instance override) and before `bodyStr` freezes them below.
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
        headers,
        model: modelId,
        tools: body.tools,
      },
      userQuery: lf.userQuery,
      lf,
      opikTraceId: traceId,
      opikKeyId: obsProjectName,
    });
  }

  const bodyStr = JSON.stringify(body);
  const sessionTurnCtx = sessionTurn
    ? buildSessionTurnContext(config, sessionTurn.seed, {
        spaceId,
        sessionInfo: sessionTurn.sessionInfo,
        authUserId: sessionTurn.authUserId,
        upstreamBody: body,
      })
    : null;

  // 结构化埋点：与 codex 对齐（forwardStart / forwardDone / info 三段式）
  pipe.forwardStart(upstreamUrl);
  const traceRequestBody = buildSafeTraceRequestBody(body);
  writeRequestLog(config, body, traceId, c.req.header("x-request-id"));

  // ── Opik: create trace (bug B7 fix 迁移时丢失, 本次补回) ──────────────────
  // 与 codex.ts / anthropic.ts 对齐。⚠️ 必须用**独立的 v7 UUID** 作 Opik
  // trace id —— 不能复用 lf.traceId (那是 Langfuse 的 sha256 hex, Opik 会
  // 以 "must be a version 7 UUID" 400 拒掉)。
  let forkTraceId: string | undefined;
  try {
    const { extractSimpleMessages: extractForOpik } = await import("../../mem-command/index.js");
    const inputMessages = extractForOpik(body.input);
    forkTraceId = opikCreateTrace(config, {
      traceId,
      projectName: obsProjectName,
      name: `${modelId} / ${obsProjectName}`,
      startTime,
      input: { messages: inputMessages, request: traceRequestBody },
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

  // usage.log 记录请求（方便运营 / 计费统计），对齐 codex writeLog 用法
  try {
    writeLog(config, {
      timestamp: startTime,
      event: "request",
      modelId,
      keyId,
      sessionKey: keyId,
      upstreamUrl,
      stream: true,
    });
  } catch {
    /* logger best-effort */
  }

  // Bug B1 fix: 老 wb 完全不接 enforceRateLimit, 由 stageGates.rateLimit 门控
  const wbAgentForForward = resolveAgentStrategy("workbuddy");
  if (wbAgentForForward.stageGates.rateLimit && !skipCreditReport) {
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

  // Bug B9 fix: 老 wb 无 AbortSignal.timeout, 上游卡死 fetch 永久 hang
  const wbForwardTimeoutMs = config.server?.forwardTimeoutMs ?? 3_600_000;

  let upstreamResp: Response;
  try {
    const fetchOpts: RequestInit = {
      method: "POST",
      headers,
      body: bodyStr,
    };
    if (wbForwardTimeoutMs > 0) {
      fetchOpts.signal = AbortSignal.timeout(wbForwardTimeoutMs);
    }
    upstreamResp = await fetch(upstreamUrl, fetchOpts);
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      pipe.info("WORKBUDDY_FORWARD_ERR", `Timeout after ${wbForwardTimeoutMs / 1000}s`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    pipe.info("WORKBUDDY_FORWARD_ERR", msg);
    // 网络层失败 → langfuse failure 上报，让线上可视化能看到
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
          requestId: traceId,
          model: modelId,
          startTime,
          endTime: new Date().toISOString(),
          input: buildWorkbuddyLangfuseInput(body),
          statusMessage: `fetch_failed: ${msg}`.slice(0, 500),
          extraTags: ["error"],
          observationMetadata: {
            stage: "forward",
            stream: true,
            upstreamUrl,
            keyId,
          },
        });
      } catch (lfErr: unknown) {
        pipe.error("LANGFUSE_SPAN", lfErr);
      }
    }
    return c.json({ error: `Upstream fetch failed: ${msg}` }, 502);
  }

  const respHeaders = filterResponseHeaders(upstreamResp.headers);
  // 上游请求 id —— 跨系统追溯用：客户端拿到的 x-request-id → 我方 usage_logs → 上游日志。
  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isSSE = contentType.includes("text/event-stream");

  pipe.forwardDone(upstreamResp.status, upstreamResp.headers.get("x-request-id") ?? undefined);
  await logPipelineUpstreamError(pipe, upstreamResp);

  // 上游 4xx/5xx → langfuse failure 上报（body 已被上游消费，不重读，避免破坏流）
  if (lf && upstreamResp.status >= 400) {
    try {
      langfuseReportFailure({
        lf,
        requestId: traceId,
        upstreamRequestId,
        model: modelId,
        startTime,
        endTime: new Date().toISOString(),
        input: buildWorkbuddyLangfuseInput(body),
        status: upstreamResp.status,
        statusMessage: `upstream_${upstreamResp.status}`,
        extraTags: ["error"],
        observationMetadata: {
          stage: "upstream",
          stream: true,
          upstreamUrl,
          keyId,
          content_type: contentType,
        },
      });
    } catch (lfErr: unknown) {
      pipe.error("LANGFUSE_SPAN", lfErr);
    }
  }

  if (!isSSE) {
    const responseText = await upstreamResp.text();
    let usage: Record<string, unknown> | undefined;
    const toolCalls = new Map<string, UpstreamToolCall>();
    let outputText = "";
    try {
      const responseBody = JSON.parse(responseText) as Record<string, unknown>;
      if (responseBody.usage && typeof responseBody.usage === "object") {
        usage = responseBody.usage as Record<string, unknown>;
      }
      mergeResponsesToolCalls(toolCalls, responseBody.output);
      outputText = collectResponsesOutputText(responseBody);
      if (upstreamResp.ok) submitSessionTurn(sessionTurnCtx, responsesReplyFromJson(responseBody), modelId);
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
        toolCalls: [...toolCalls.values()],
        usage: usage ?? {},
      }, pipe, preparedStats);
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
        config, gates: wbAgentForForward.stageGates,
        isCustomUpstream: skipCreditReport,
        spaceId,
        modelId, usage, protocol: "responses",
      }).catch((rlErr: unknown) => pipe.error("RATE_LIMIT_RECORD", rlErr));
      const creditResult = await stageCredit({
        skipCreditReport, config, path: c.req.path, usage, effectiveModel: modelId,
        upstreamUrl, event: "usage", startTime: new Date(startTime),
        reqIds: pipe.ids(), upstreamRequestId,
        sessionKey: lf?.sessionId ?? keyId, stream: false,
        keyId, routedFrom: "",
      }, pipe);
      if (creditResult.responseErrorHeader) {
        respHeaders.set("x-credit-report-error", creditResult.responseErrorHeader);
      }
    }
    // 最后一公里：notify / 日志 / 计费都已经看过原始响应，这里才动给客户端的那份。
    const clientResponseText = stripCfqFromResponseText(
      "responses",
      responseText,
      preparedStats,
      createCfqStripObserver(pipe),
    );
    // v3.3 user-session-default: 命中账户默认时在 output[] 前面插 ✅ 绑定提示 message。
    let finalResponseText = clientResponseText;
    if (defaultBindingNotice) {
      try {
        const parsed = JSON.parse(clientResponseText);
        const patched = prependNoticeToResponsesJson(parsed, defaultBindingNotice);
        finalResponseText = JSON.stringify(patched);
      } catch {
        // 非 JSON (理论上不会) → 原样返回, 丢 notice 但不破坏响应
      }
    }
    pipe.responseDone(usage ?? null);
    return new Response(finalResponseText, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  // Main turns are tapped for observability/archive; auxiliary Responses calls
  // are tapped for credit only.
  if (!upstreamResp.body || (!lf && skipCreditReport)) {
    // 不 tap 也要剥离：注入与否跟观测无关，客户端校验一样会拒。
    // v3.3: 若命中账户默认, 同样在最前面插 ✅ 绑定提示 (流式)。
    const stripped = upstreamResp.body
      ? upstreamResp.body.pipeThrough(createCfqStripStream(
          "responses",
          preparedStats,
          createCfqStripObserver(pipe),
        ))
      : null;
    const clientStream = stripped
      ? prependNoticeToResponsesStream(stripped, defaultBindingNotice)
      : null;
    return new Response(
      clientStream,
      {
        status: upstreamResp.status,
        headers: respHeaders,
      },
    );
  }

  // SSE + langfuse: tee & tap
  const observedStream = withStreamIdleWarning(upstreamResp.body, {
    spaceId,
    traceId,
    requestId: traceId,
    upstreamRequestId,
    model: modelId,
    protocol: "responses",
    branch: "upstream_body",
  });
  const [passStream, tapStream] = observedStream.tee();
  void consumeWorkbuddyStream(tapStream, {
    startTime,
    modelId,
    keyId,
    obsProjectName,
    traceId,
    forkTraceId,
    lf,
    config,
    requestPath: c.req.path,
    spaceId,
    upstreamRequestId,
    skipCreditReport,
    preparedStats,
    pipe,
    archiveCtx,
    inputBody: body,
    upstreamUrl,
    sessionTurnCtx: upstreamResp.ok ? sessionTurnCtx : null,
  });

  // CFQ 剥离排在最后：tap 走的是另一条 tee 分支，读到的仍是模型原始输出。
  // v3.3: 命中账户默认时在客户端那份流前面插 ✅ 绑定提示事件。
  const clientStream = prependNoticeToResponsesStream(
    passStream.pipeThrough(createCfqStripStream(
      "responses",
      preparedStats,
      createCfqStripObserver(pipe),
    )),
    defaultBindingNotice,
  );
  return new Response(
    clientStream,
    {
      status: upstreamResp.status,
      headers: respHeaders,
    },
  );
}

/**
 * WorkBuddy tap context —— consumeWorkbuddyStream 的参数类型。
 */
interface WorkbuddyTapContext {
  startTime: string;
  modelId: string;
  keyId: string;
  /** Opik project the turn trace was created in (`wecomName || keyId`). */
  obsProjectName: string;
  traceId: string;
  /** Opik fork trace id (request_log 项目)；opik 关闭时 undefined。 */
  forkTraceId?: string;
  lf: LangfuseTurnContext | null;
  config: ProxyConfig;
  requestPath: string;
  /**
   * Session composite key (`${agentSource}:${sessionId}`), 用于 modelIntent
   * telemetry 和 skill extract 的 sessionKey 字段。runner 在构造 tap ctx 时
   * 以 `${lf.sessionId}` 传入 (老代码一直这么写)。
   */
  sessionKey?: string;
  /** Tenant the usage is billed to; ClickHouse filters on it. */
  spaceId: string;
  /** Upstream `x-request-id`, carried for cross-system tracing. */
  upstreamRequestId: string;
  skipCreditReport: boolean;
  /** Opaque counters from the preparation stage, recorded with the usage log. */
  preparedStats: Record<string, unknown> | null;
  pipe: ReturnType<typeof createPipeline>;
  archiveCtx: WorkbuddyArchiveCtx | null;
  /**
   * 转发到上游的最终 body（含注入后的 input[]）。用于两个地方：
   *   1) langfuse observation.input（buildWorkbuddyLangfuseInput）
   *   2) 兜底 —— 目前未用，但对齐 codex 便于后续扩展
   */
  inputBody: Record<string, unknown>;
  /** 上游 URL，写进 observationMetadata 便于排障 */
  upstreamUrl: string;
  /** Online session trace for this call; null when it is not recorded. */
  sessionTurnCtx: SessionTurnContext | null;
}

/**
 * Consume an SSE stream from upstream, extract text + usage, report to
 * langfuse, then trigger L0 write + skill extraction hooks.
 * Runs asynchronously without blocking the downstream response.
 *
 * 关键机制（对齐 codex 但保留 workbuddy 现有 try/finally 风格）：
 *   - 上游流生命周期由 server.forwardTimeoutMs 的 AbortSignal 统一约束
 *   - toolUseCount 累积：Responses API 里 `response.output_item.done` +
 *     `item.type==="function_call"` 计一次工具调用；透传给 skill 归档做
 *     round 边界判据
 *   - buildWorkbuddyLangfuseInput(inputBody)：把 body.input + instructions
 *     结构化写入 langfuse observation.input，便于排障
 */
async function consumeWorkbuddyStream(
  stream: ReadableStream<Uint8Array>,
  ctx: WorkbuddyTapContext,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let assistantText = "";
  let usage: Record<string, unknown> | undefined;
  let responseId: string | undefined;
  // Q: 累积当前 turn 内的 function_call 次数（round 边界判据）
  let toolUseCount = 0;
  // 按 call_id 累积工具调用，供增量会话的 CFQ 侧信道使用。output_item.done
  // 与 completed 会重复给出同一条，Map 去重后以终态为准。
  const toolCalls = new Map<string, UpstreamToolCall>();
  const replyAssembler = ctx.sessionTurnCtx ? new ResponsesAssembler() : null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6));
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload) as Record<string, unknown>;
          const evtType = evt.type as string | undefined;
          replyAssembler?.push(evt);
          if (evtType === "response.output_text.delta") {
            const delta = evt.delta;
            if (typeof delta === "string") assistantText += delta;
          }
          // Q: 工具调用计数（对齐 codex 的判据）—— 仅在 output_item.done
          // 且 item.type==="function_call" 时 +1；不要放在 response.completed
          // 里，避免多算或漏算。
          if (evtType === "response.output_item.done") {
            const item = evt.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") toolUseCount++;
            if (item) mergeResponsesToolCalls(toolCalls, [item]);
            // response.output_item.done 里的 resp 语义与 codex 保持一致：
            // 有些上游会在这里把 usage/response.id 一起吐出（stream 内多次
            // done），下面 completed 分支才是权威 usage 来源。
            const resp = (evt.response ?? evt) as Record<string, unknown>;
            if (typeof resp?.id === "string") responseId = resp.id as string;
            if (resp?.usage && typeof resp.usage === "object") {
              usage = resp.usage as Record<string, unknown>;
            }
          }
          if (evtType === "response.completed") {
            const resp = (evt.response ?? evt) as Record<string, unknown>;
            if (typeof resp?.id === "string") responseId = resp.id as string;
            if (resp?.usage && typeof resp.usage === "object") {
              usage = resp.usage as Record<string, unknown>;
            }
            mergeResponsesToolCalls(toolCalls, resp?.output);
          }
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  } catch (err) {
    ctx.pipe.info("WORKBUDDY_STREAM_ERR", err instanceof Error ? err.message : String(err));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  if (replyAssembler) {
    parseSseData(buf).forEach((evt) => replyAssembler.push(evt));
    submitSessionTurn(ctx.sessionTurnCtx, replyAssembler.result(), ctx.modelId);
  }

  const endTime = new Date().toISOString();
  if (ctx.lf) {
    void notifyUpstreamResponse(ctx.config, {
      protocol: "responses",
      sessionKey: ctx.lf.sessionId,
      model: ctx.modelId,
      stream: true,
      turnSeq: ctx.lf.turnSeq,
      text: assistantText,
      toolCalls: [...toolCalls.values()],
      usage: usage ?? {},
    }, ctx.pipe, ctx.preparedStats);
  }
  if (usage && Object.keys(usage).length > 0) {
    // wb 老行为: writeLog(usage) 无 gate 恒写 (与 codex 对齐, 避免任何 preset 档位让 wb 停写)
    stageWriteUsageLog({
      config: ctx.config, pipe: ctx.pipe,
      timestamp: endTime, modelId: ctx.modelId,
      keyId: ctx.keyId,
      sessionKey: ctx.lf?.sessionId ?? ctx.keyId,
      turnSeq: ctx.lf?.turnSeq,
      userInput: ctx.lf?.userQuery || undefined,
      upstreamUrl: ctx.upstreamUrl, usage,
      requestReceivedAt: ctx.startTime,
      extensionStats: ctx.preparedStats ?? undefined,
      spaceId: ctx.spaceId,
      upstreamRequestId: ctx.upstreamRequestId,
    });
  }
  try {
    await stageCredit({
      skipCreditReport: ctx.skipCreditReport,
      config: ctx.config,
      path: ctx.requestPath,
      usage,
      effectiveModel: ctx.modelId,
      upstreamUrl: ctx.upstreamUrl,
      event: "usage",
      startTime: new Date(ctx.startTime),
      reqIds: ctx.pipe.ids(),
      upstreamRequestId: ctx.upstreamRequestId,
      sessionKey: ctx.keyId,
      stream: true,
      keyId: ctx.keyId,
      routedFrom: "",
    }, ctx.pipe);
  } catch (err: unknown) {
    ctx.pipe.error("CREDIT_REPORT", err instanceof Error ? err : new Error(String(err)));
  }
  if (ctx.lf) {
    try {
      // R: 用结构化 input 上报（body.input + instructions），便于 langfuse UI 排障
    langfuseReportGeneration({
      traceId: ctx.lf.traceId,
      requestId: ctx.traceId,
      upstreamRequestId: ctx.upstreamRequestId,
      name: `workbuddy:${ctx.modelId}`,
      model: ctx.modelId,
      startTime: ctx.startTime,
      endTime,
      input: buildWorkbuddyLangfuseInput(ctx.inputBody),
      output: assistantText,
      usage: usage && Object.keys(usage).length > 0 ? usage : undefined,
      traceName: ctx.lf.traceName,
      userId: ctx.lf.userId,
      sessionId: ctx.lf.sessionId,
      instanceId: ctx.lf.instanceId,
      tags: ctx.lf.tags,
      traceInput: ctx.lf.userQuery || undefined,
      traceOutput: assistantText,
      observationMetadata: {
        stream: true,
        response_id: responseId,
        keyId: ctx.keyId,
        upstreamUrl: ctx.upstreamUrl,
        tool_use_count: toolUseCount,
      },
    });
    } catch (err) {
      ctx.pipe.info(
        "WORKBUDDY_LANGFUSE_ERR",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Opik LLM span (bug B7, gated by stageGates.opik) ──
  const wbAgentStrategy = resolveAgentStrategy("workbuddy");
  if (ctx.config && usage && Object.keys(usage).length > 0) {
    stageOpikStreamSpan({
      config: ctx.config, gates: wbAgentStrategy.stageGates, pipe: ctx.pipe,
      // ⚠️ 必须用 Opik 自己的 trace id (ctx.traceId, v7 UUID)。
      // 曾经这里错用 ctx.lf.traceId —— 那是 Langfuse 的 sha256 hex,
      // Opik 以 "must be a version 7 UUID" 400 拒掉整个 span。
      traceId: ctx.traceId,
      forkTraceId: ctx.forkTraceId,
      keyId: ctx.keyId, projectName: ctx.obsProjectName, modelId: ctx.modelId,
      startTime: ctx.startTime, endTime,
      inputMessages: [{ role: "user", content: JSON.stringify(ctx.inputBody?.input ?? []) }],
      outputMessage: assistantText ? { role: "assistant", content: assistantText } : null,
      usage, retried: false, upstreamUrl: ctx.upstreamUrl,
      streamTag: "stream",
    });
  }

  // ── ModelIntent telemetry (bug B4, gated by stageGates.modelIntentTelemetry) ──
  // wb 独有: doesn't accumulate toolCalls, emit synthetic counter only
  if (toolUseCount > 0) {
    stageEmitModelIntent({
      gates: wbAgentStrategy.stageGates,
      sessionKey: `workbuddy:${ctx.sessionKey}`,
      turnSeq: ctx.lf?.turnSeq ?? 0,
      spaceId: ctx.spaceId,
      userId: ctx.keyId,
      agentSource: "workbuddy",
      intents: [{ name: "wb_tool_use", arguments: `count=${toolUseCount}` }],
    });
  }

  // ── recordInputTokenUsage (bug B1 stream side, gated by stageGates.rateLimit) ──
  if (ctx.config && usage && Object.keys(usage).length > 0) {
    await stageRecordTokenUsage({
      config: ctx.config, gates: wbAgentStrategy.stageGates,
      isCustomUpstream: !!ctx.skipCreditReport,
      spaceId: ctx.spaceId,
      modelId: ctx.modelId, usage, protocol: "responses",
    }).catch((rlErr: unknown) => ctx.pipe.error("RATE_LIMIT_RECORD", rlErr));
  }

  // ── TDAI L0 write + Skill extraction ──
  // 对齐 codexHandler triggerCodexArchiveHooks: langfuse 上报后触发归档。
  // archiveCtx=null (aux/未初始化 session/bypass) 直接跳过。
  // Q: toolUseCount 透传给 skill 归档，作为 round 边界判据。
  if (ctx.archiveCtx && assistantText) {
    await triggerWorkbuddyArchiveHooks(ctx.archiveCtx, assistantText, toolUseCount).catch(
      (err: unknown) => {
        ctx.pipe.info(
          "WORKBUDDY_ARCHIVE_ERR",
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  }
  ctx.pipe.streamDone(usage && Object.keys(usage).length > 0 ? usage : null);
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * WorkBuddy endpoint handler.
 *
 * 10-段流程（与 codex/anthropic/openai 三家 handler 对齐，便于对读）：
 *   1. Auth        - Bearer token / x-api-key 验签
 *   2. Body- 解析 JSON body
 *   3. Headers     - 提取小写化的请求头 map
 *   4. Classify    - main vs auxiliary
 *   5. Aux         - 短路透传（不注入、不上报 langfuse）
 *   6. Session ID  - header/body 提取 session id，构造 langfuse turn ctx
 *   7. Session init- 复用 CB 状态机 (handleSessionInit, agentSource="codex")
 *                   + codex form builder 渲染 Responses API SSE 弹窗
 *   8. Mem command - / 命令拦截（session 已注册时）
 *   9. Injection   - 通用 injection pipeline，注入到 body.input[0].content[]
 *   10. Forward    - 转发上游 + tap SSE 上报 langfuse
 */
export async function runWorkbuddyPipeline(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const requestStartMono = performance.now();
  const path = c.req.path;

  // ── 1. Auth (via shared stageAuth) ───────────────────────────────────
  const auth = await stageAuth(c, "bearer-first");
  const apiKey = auth.apiKey;
  const spaceId = auth.spaceId;
  const userId = auth.userId;
  if (auth.rejected) {
    return c.json({ error: `Authentication failed: ${auth.rejectReason ?? "unknown"}` }, 401);
  }
  const keyId = auth.keyId;

  // ── 2. Read body (via shared stageParseBody) ─────────────────────────
  const parseResult = await stageParseBody(c);
  if (!parseResult.ok) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  // ⚠️ `let` 不能改回 `const`: 下面 § 9 注入阶段 (line 1616 附近)
  // 会 `body = injectWorkbuddyAssets(body, ...)` 原地替换为注入后的新对象。
  // c6fa775d (stageParseBody 迁移) 不小心改成了 const, 导致运行时
  // 抛 "Assignment to constant variable", catch 后降级为**无注入透传** —
  // workbuddy 的 skill/memory/session_context 从此全丢。TS 2588 一直报警
  // 但被当成"重构遗留基线错误"没人修。
  let body = parseResult.body;
  let wecomName = "";
  if (hasExplicitAgentName(path)) {
    const wecomIdentity = await requireWecomIdentity(config, apiKey, body, "responses");
    if (wecomIdentity.kind !== "resolved") return wecomIdentity.response;
    wecomName = wecomIdentity.name;
  }
  const poolRejection = poolServiceRejection(config, body.model);
  if (poolRejection) return c.json(poolRejection, 400);

  // ── 3. Extract headers ───────────────────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
  }

  // ── Identity 埋点 (bug B5 fix, gated by stageGates.identityRecord) ──
  const wbAgent = resolveAgentStrategy("workbuddy");
  if (wbAgent.stageGates.identityRecord) {
    stageIdentity(c, body, "workbuddy");
  }

  // ── 4. Classify request ──────────────────────────────────────────────────
  // 关闭 workbuddyRequestRouting.enabled 时强制视为 main，走完全等价 aux 分流
  // 未启用的老链路。运维回滚保险；默认启用。对齐 CC 的 ccRequestRouting.enabled
  // 语义，但默认相反（CC 默认 false 是灰度上线；WB 默认 true 是保守回滚）。
  const wbRoutingEnabled = config.workbuddyRequestRouting?.enabled !== false;
  const requestKind = wbRoutingEnabled
    ? classifyWorkbuddyRequest(body, path, headers)
    : "main";
  const isAuxiliary = requestKind === "auxiliary";

  const requestedModel = typeof body.model === "string" ? body.model : "";

  // ── Model gate (bug B8 fix, gated by stageGates.modelGate) ──
  const _wbSpaceIdForGate = extractSpaceIdFromPath(path) ?? "";
  let _wbIsCustomUpstream = false;
  if (wbAgent.stageGates.modelGate && !isAuxiliary) {
    try {
      const { getInstanceUpstreamConfigs, resolveForAgent, shouldOverride } =
        await import("../../instance-upstream-cache.js");
      const cfgs = await getInstanceUpstreamConfigs(config.coreSkill, _wbSpaceIdForGate, config.instanceUpstream);
      _wbIsCustomUpstream = shouldOverride(resolveForAgent(cfgs, "workbuddy"));
    } catch {
      _wbIsCustomUpstream = false;
    }
    if (!_wbIsCustomUpstream) {
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
  const pipe = createPipeline(config, traceId, modelId, {
    spaceId: _wbSpaceIdForGate,
    protocol: "responses",
    startedAt: startTime,
    startedMono: requestStartMono,
  });
  pipe.requestReceived(Array.isArray(body.input) ? body.input.length : 0, body.stream !== false);

  // ── 5. Aux passthrough ───────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("WORKBUDDY_AUX", `auxiliary request → passthrough (path=${path})`);
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, wecomName || keyId, modelId, pipe, null, null);
  }

  // ── 6. Session ID + langfuse turn ctx ────────────────────────────────────
  const sessionId = extractWorkbuddySessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "workbuddy";
  const isStream = body.stream !== false;
  const callerUserKey = apiKey || null;
  const sessionTurnSeed = createSessionTurnSeed(config, {
    agent: agentSource,
    path,
    protocol: "responses",
    headers,
    body,
    sessionId: sessionKey,
    startedAt: startTime,
  });

  const turnSeq = countHumanTurnsResponses(body.input);
  const userQuery = workbuddyAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${wecomName || keyId}`,
    userId: wecomName || keyId,
    sessionId: sessionKey,
    // 记忆实例 ID（kernel tenant）—— 供 Langfuse 按实例筛选/归集。
    // 内部仍叫 spaceId（CH/credit 命名）；只有 Langfuse 对外叫 instanceId。
    instanceId: spaceId || undefined,
    tags: [
      `agent_source:${agentSource}`,
      "protocol:responses",
      isStream ? "stream" : "non-stream",
      `session:${sessionKey}`,
    ],
    routeTags: [],
    userQuery,
  };

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ───
  //
  // WorkBuddy 与 codex 走同一份 Responses API wire，弹窗骨架直接复用 codex/form.ts
  // 的 buildFormResponse + CB 状态机（handleSessionInit + agentSource="codex"）。
  // 这里的 agentSource 传 "codex" 而非 "workbuddy" —— 因为状态机内部靠 source 决定：
  //   - 是否走两步式分页 (codex-only)
  //   - Default gate 字符串识别
  //   - formData.{teamPage,agentPage,taskPage} 是否填充
  // 三者都是 codex 客户端专有行为，WorkBuddy 亦然。langfuse tag/日志侧的
  // agent_source 保持 "workbuddy" 不受影响。
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("../../injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  /** session-init 状态机在本轮完成注册 —— 本轮不触发 client_tool skill 加载。 */
  let sessionJustRegistered = false;
  /**
   * v3.3 user-session-default: 命中账户默认时, 由 session-init 填充的用户可见
   * 绑定提示文本 (markdown)。runner 层把它作为参数传给 forwardToUpstream,
   * 后者在响应最前面插入(非流式改 output[], 流式插 output_text 事件组)。
   */
  let defaultBindingNotice: string | null = null;
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamName?: string; teamIdShort: string; taskName?: string | null; bypassed?: boolean } | null = null;
  // injectionSkipped is finalized once teamMemoryEnabled is known (a few lines below).

  const input = Array.isArray(body.input) ? body.input : [];

  // Instance-level team_memory master switch. Flipping to "0" at Core bypasses
  // session_init + mem commands + injection; cost-guard / credit / forward
  // untouched. See MemoryProxy/docs/design/2026-10-13-team-memory-master-switch.md §6.
  const teamMemoryEnabled = await stageTeamMemorySwitch({
    config, spaceId, userKey: callerUserKey, userId,
  });
  if (!teamMemoryEnabled) {
    console.log(`[team-memory-switch] disabled: spaceId=${spaceId} user=${userId} → team memory off (workbuddy)`);
    injectionSkipped = true;
  }

  // ── mem:session-reset pre-hook (via shared stage) ──
  // wb 用 `codex:${sessionKey}` 作 compositeKey (workbuddy agent 复用 codex adapter/state)
  {
    const { workbuddyAdapter } = await import("../../agent-adapters/workbuddy.js");
    const userText = workbuddyAdapter.extractUserText(input) ?? "";
    const _resetResp = await stageSessionResetPreHook({
      c, config, body: body as Record<string, unknown>, agentSource, sessionKey, spaceId, userId,
      isAuxiliary: false, dshHeadless: false, isStream,
      protocol: "responses", userText, enabled: teamMemoryEnabled,
      compositeKeyOverride: `codex:${sessionKey}`,
    });
    if (_resetResp) return _resetResp;
  }
  if (config.sessionInit?.enabled && sessionId && teamMemoryEnabled) {
    try {
      // Round 18: session-init 主编排走 shared stageSessionInitOrchestrate;
      // workbuddy 4 个 callback:
      //   - synthesizeMessages: codexFormAnswersAsMessages(input) (与 codex 对称)
      //   - buildRecoverInitResult: systemAppend + messages:[] (responses API)
      //   - buildInterceptResponse: buildCodexFormResponse (借用 codex form builder)
      //   - buildDefaultGateResponse: wb 独有 Plan 提示 (含 reset 场景文案分支)
      // wb 独有: compositeKeyOverride="codex:..." (借 codex L2b binding),
      //          agentSourceForState="codex" (复用 CB 分支)
      const _orch = await stageSessionInitOrchestrate({
        agentSourceForState: "codex",
        compositeKeyOverride: `codex:${sessionKey}`,
        sessionKey, userId: userId || null, spaceId,
        config: config as ProxyConfig & { sessionInit: NonNullable<ProxyConfig["sessionInit"]> },
        kernelUserKey: apiKey,
        headers, recoveryMessages: [],
        synthesizeMessages: () => {
          const synth = codexFormAnswersAsMessages(input);
          const rawOutputs = input
            .filter((it: any) => it?.type === "function_call_output")
            .map((it: any) => ({
              call_id: it.call_id,
              output_preview: String(it.output ?? "").slice(0, 200),
            }));
          if (rawOutputs.length > 0) {
            console.log(
              `[workbuddy-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synth).slice(0, 500)}`,
            );
          }
          return synth;
        },
        buildRecoverInitResult: async (recovered) => {
          const { buildSessionContextBlockWithToggles } = await import(
            "../../session/context-injector.js"
          );
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
            // v3.3: 账户默认失效原因透传给 codex form（workbuddy 借用 codex builder）。
            notice: initResult.formData.notice,
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        },
        buildDefaultGateResponse: (initResult) => {
          if ((initResult as any).bypassReason !== "default-gate") return null;
          pipe.info("WORKBUDDY_GATE", "Default mode gate detected → notify user (first hit)");
          const gateText = (initResult as any).resetFlow
            ? "⚠️ mem:session-reset 需要 Plan 模式支持。\n\n"
              + "workbuddy 客户端当前不在 Plan 模式，无法弹出资产选择表单。\n"
              + "请切到 Plan 模式后再执行 mem:session-reset。"
            : "检测到未开启 Plan 模式，本次会话跳过资产注入。"
              + "如需管理 Skill / Task / Agent，请切到 Plan 模式后重新开启新会话。"
              + "本次消息将直接由 LLM 回答。";
          return buildMemResponse(gateText, {
            protocol: "responses",
            stream: isStream,
            requestId: `workbuddy-gate-${Date.now()}`,
          });
        },
      });
      if (!_orch.proceed) return _orch.response!;
      const initResult = _orch.initResult!;
      const wentThroughSessionInitStateMachine = _orch.wentThroughStateMachine;
      void wentThroughSessionInitStateMachine; // wb 不显式用, 但保留占位方便对齐 anthropic/openai

      // Bypass path → skip injection (via shared stageSessionBypass)
      // wb 独有: log 里带 bypassReason; resetFlow 用 teamIdShort 字段
      const _bypassResult = stageSessionBypass({
        bypassed: !!initResult.bypassed,
        resetFlow: !!initResult.resetFlow,
        sessionKey,
        logPrefix: "[workbuddy]",
        extraLog: ` (reason=${(initResult as any).bypassReason ?? "unknown"})`,
        useTeamIdShort: true,
      });
      if (_bypassResult.skipInjection) injectionSkipped = true;
      if (_bypassResult.resetFlowResult) _resetFlowResult = _bypassResult.resetFlowResult as unknown as typeof _resetFlowResult;

      assetCapabilities = await stageAssetCapabilities({
        bypassed: !!initResult.bypassed,
        sessionInfo: initResult.sessionInfo,
        config, spaceId,
        userKey: callerUserKey,
        warnPrefix: "[workbuddy] asset-capability resolve failed:",
      });

      // Prewarm 前置短路：mem-command 命中的 turn 不走 forward、不消费 hook-cache，
      // 若照常 prewarm 会白花 2-3s + 3 次网络请求。见 handler.ts 对称位置详注。
      let memCommandPending = false;
      {
        try {
          const userTextPeek = workbuddyAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText } = await import("../../mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek) {
              memCommandPending = true;
              console.log(`[workbuddy] prewarm skipped: mem-command pending (cmd=${peek.command}) session=${sessionKey}`);
            }
          }
        } catch (err) {
          console.warn(
            "[workbuddy] pre-prewarm peek failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      await stagePrewarmInjection({
        bypassed: !!initResult.bypassed,
        justRegistered: !!initResult.justRegistered,
        sessionInfo: initResult.sessionInfo,
        agentDetail: initResult.agentDetail,
        taskDetail: initResult.taskDetail,
        memCommandPending,
        config, sessionKey, userId, agentSource, spaceId, assetCapabilities,
        callerUserKey: callerUserKey ?? undefined,
        logTag: "[workbuddy] prewarm error:",
      });

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

      if (initResult.justRegistered) sessionJustRegistered = true;

      // v3.3 user-session-default: 命中账户默认时, 把绑定提示捞出来传给 forwardToUpstream。
      // 只在 justRegistered 的那一次插; 后续轮次 initResult.defaultBindingNotice 为 null。
      if (initResult.justRegistered && (initResult as any).defaultBindingNotice) {
        defaultBindingNotice = (initResult as any).defaultBindingNotice as string;
        console.log(`[session-init] session=${sessionKey} default-binding-notice staged (len=${defaultBindingNotice.length})`);
      }

      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "未知",
          // agentIdShort 字段名沿用历史，但此处**存完整 agent_id**（如 agt-1celthr7yn）。
          // 之前 slice(-8) 会截断成 "elthr7yn" 用户看不懂，与 team 截断问题对称。
          agentIdShort: initResult.sessionInfo?.agent_id
            ? String(initResult.sessionInfo?.agent_id) : "",
          // teamName 来自 session-init 返回值（从 cachedTeams 里查得）；
          // teamIdShort 字段名沿用历史，但此处**存完整 team_id**（如 team-wyuyb7sion）。
          // 之前 slice(-8) 只留后 8 位会让用户看到 "uyb7sion" 这种截断串，配合
          // teamName 常为空导致的兜底路径显示极不完整。团队 id 本身就短，全量展示无害。
          teamName: initResult.teamName ?? undefined,
          teamIdShort: initResult.sessionInfo?.team_id
            ? String(initResult.sessionInfo?.team_id) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error(
        "[workbuddy] session-init error:",
        err instanceof Error ? err.message : String(err),
      );
      sessionInfo = undefined;
      injectionSkipped = true;
    }
  }

  // ── mem:session-reset 完成确认 (via shared stage) ────────────────────────
  // wb 用 teamIdShort 字段名, 但 stage 期望 teamId — 直接映射
  if (_resetFlowResult) {
    const { teamIdShort, ...rest } = _resetFlowResult;
    return stageSessionResetConfirmation({
      resetFlowResult: { ...rest, teamId: teamIdShort },
      protocol: "responses",
      isStream,
    });
  }

  // ── 8. mem-command intercept (via shared stage) ─────────────────────────
  // 迁移说明: 本块原为 ~130 行 inline 实现 (解析 / 执行 / L0 / skill / langfuse
  // 各自手写一遍), 与 CC/CB/Codex 的 `stageMemCommandIntercept` 分家。分家的代价
  // 是: 新增 mem 命令要改多处, 且 wb 独有的 extractUserText 边界问题无法被
  // 其他客户端的修复覆盖 —— 用户实测 `mem:config-lock` / `mem:config-unlock`
  // 在 wb 上被透传给 LLM (LLM 只能瞎编回复), 而 CC/CB/Codex 正常。
  //
  // 现在统一走 stage:
  //   - protocol="responses" + userText → stage 内部用 parseCommandFromText,
  //     正是 Responses API (body.input[]) 的正确解析路径;
  //   - assistantContentFormat="responses-message" → 命令响应按 Responses 形态渲染;
  //   - langfuseCtx 复用 wb 已构造的 lf, 保持 traceId 空间不变;
  //   - upstreamProtocol="openai" 保留 wb 独有语义 (主链路上游走 chat/completions,
  //     与 protocol="responses"(仅用于渲染响应骨架) 无关)。
  {
    const { extractSimpleMessages } = await import("../../mem-command/index.js");
    const memResp = await stageMemCommandIntercept({
      enabled: teamMemoryEnabled,
      body,
      agentSource,
      sessionKey,
      sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
      injectionSkipped,
      sessionJustRegistered,
      config,
      spaceId,
      userId: userId || "",
      apiKey: apiKey || "",
      callerUserKey: callerUserKey ?? undefined,
      isStream,
      protocol: "responses",
      modelId: modelId as string,
      upstreamUrl: config.upstream.agents?.["workbuddy"]?.url || config.upstream.url,
      // Responses API: 从 body.input[] 提取的最后一条 user 文本 → parseCommandFromText。
      // stage 在 protocol==="responses" 且 userText 非 undefined 时走这条解析链。
      userText: workbuddyAdapter.extractUserText(input) ?? undefined,
      messages: input,
      createTdaiClientFn: createWorkbuddyTdaiClient,
      bodyMessages: extractSimpleMessages(input),
      assistantContentFormat: "responses-message",
      startTime,
      keyId,
      assetCapabilities,
      upstreamProtocol: "openai",
      langfuseCtx: {
        traceId: lf.traceId,
        userId: lf.userId,
        sessionId: lf.sessionId,
        tags: lf.tags,
        instanceId: lf.instanceId,
      },
    });
    if (memResp) return memResp;
  }

  // ── 9. Asset injection (每轮都跑) ────────────────────────────────────────
  if (
    !injectionSkipped &&
    sessionInfo &&
    config.injection?.enabled &&
    (config.injection.injectors?.length ?? 0) > 0
  ) {
    try {
      const { getInjectionPipeline } = await import("../../injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const { buildSessionContextBlockWithToggles } = await import(
        "../../session/context-injector.js"
      );
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as import("../../session/types.js").AgentDetail | null,
        cachedTaskDetail as import("../../session/types.js").TaskDetail | null,
        config.sessionInit,
        sessionKey,
      );

      // 构造 synthetic OpenAI body 供通用 pipeline 处理
      const syntheticBody: Record<string, unknown> = {
        messages: [
          { role: "system", content: sessionContextBlock ?? "" },
          { role: "user", content: userQuery || "." },
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
        turnSeq,
        requestPath: path,
        custom: {
          session: sessionInfo,
          userKey: callerUserKey ?? undefined,
          assetCapabilities,
          // 合成 body 只抽取 system 文本，消息级注入（selected skill）无处落地。
          messageInjection: false,
        },
      });

      const injectedMessages = injectedBody.messages as
        | Array<Record<string, unknown>>
        | undefined;
      const sysMsg = injectedMessages?.[0];
      const injectedText = typeof sysMsg?.content === "string" ? sysMsg.content : "";

      if (injectedText.length > 0) {
        body = injectWorkbuddyAssets(body, { raw: injectedText });
      }
    } catch (err: unknown) {
      console.error(
        "[workbuddy] injection pipeline error:",
        err instanceof Error ? err.message : String(err),
      );
      // Degrade gracefully: forward without injection
    }
  }

  // ── 9b. Skill selection (proxy 选择 → 客户端加载) ───────────────────────────
  // 与 codex 对称：Responses 协议，新用户轮次直接返回 function_call 由客户端加载。
  if (!injectionSkipped && !sessionJustRegistered && sessionInfo && Array.isArray(body.input)) {
    const { tryClientToolDelivery } = await import("../../skill/selection/delivery/client-tool.js");
    const resp = await tryClientToolDelivery(config, {
      protocol: "responses",
      body,
      messages: body.input,
      upstreamUrl: "",
      stream: isStream,
      model: String(modelId ?? ""),
      session: sessionInfo as Parameters<typeof tryClientToolDelivery>[1]["session"],
      conversationId: sessionId,
      sessionKey,
      agentSource: "workbuddy",
      skillCapability: assetCapabilities?.skill !== false,
    });
    if (resp) return resp;
  }

  // ── 10. Forward ──────────────────────────────────────────────────────────
  const archiveCtx = buildWorkbuddyArchiveCtx({
    config,
    sessionInfo,
    injectionSkipped,
    input,
    sessionKey,
    userId: userId || "",
    callerUserKey,
    assetCapabilities,
  });
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, wecomName || keyId, modelId, pipe, lf, archiveCtx, {
    seed: sessionTurnSeed,
    sessionInfo,
    authUserId: userId,
  }, defaultBindingNotice);
}
