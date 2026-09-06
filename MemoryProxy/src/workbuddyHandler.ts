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
import type { ProxyConfig } from "./types.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import { createPipeline, writeLog } from "./logger.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import { joinUrl } from "./guard-adapter.js";
import { verifyUserKey } from "./auth.js";
import { resolveModelId } from "./pricing.js";
import { workbuddyAdapter } from "./agent-adapters/workbuddy.js";
import {
  buildWorkbuddyInjectionBlock,
  type WorkbuddyInjectionInput,
} from "./common/workbuddy-injection.js";
// WorkBuddy 走 Responses API，与 codex wire 完全一致 —— 弹窗骨架直接复用
// session/codex/form.ts 的 buildFormResponse + codexFormAnswersAsMessages，
// 状态机复用 CB 的 handleSessionInit(agentSource="codex")。这样 WorkBuddy
// 本身不需要单独做一套 form 骨架。
import {
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "./session/codex/form.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";

// ── TDAI L0 + Skill extraction imports ────────────────────────────────────────
import { TdaiClient } from "./tdai/client.js";
import { deriveTdaiIdentity } from "./tdai/identity.js";
import { recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";

// ── Handler-level constants ──────────────────────────────────────────────────

const SKIP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "x-tdai-user-key",
]);

const SKIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
]);

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
  const fromHeader = headers["session-id"] ?? headers["Session-Id"];
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
export function countHumanTurnsWorkbuddy(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type !== "message") continue;
    if (it.role !== "user") continue;
    count++;
  }
  return count;
}

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
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
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

function createWorkbuddyTdaiClient(config: ProxyConfig): TdaiClient | null {
  if (!config.tdai?.enabled || !config.tdai?.memory?.enabled || !config.tdai?.endpoint) return null;
  return new TdaiClient({
    enabled: config.tdai.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

function buildWorkbuddyArchiveCtx(args: {
  config: ProxyConfig;
  sessionInfo: Record<string, unknown> | null | undefined;
  injectionSkipped: boolean;
  input: unknown[];
  sessionKey: string;
  userId: string;
  callerUserKey?: string | null;
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
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
 * @param ctx         归档上下文 (非 null 时有效)
 * @param assistantText stream accumulator 累积的 assistant 文本
 */
async function triggerWorkbuddyArchiveHooks(
  ctx: WorkbuddyArchiveCtx,
  assistantText: string,
  toolCallCountOverride?: number,
): Promise<void> {
  // ── TDAI L0 write ──
  // 与 codexHandler triggerCodexArchiveHooks 对称:
  //   trackWrite 挂全局 in-flight set (index.ts flushPendingWrites 兜底)
  //   withL0Retry 3 次退避挡 tdai kernel 瞬断
  //   stream 场景不 await, 让归档 hook 提前返回
  //
  // 注意：buildWorkbuddyArchiveCtx 已在 chat_memory=false 时把 tdaiClient 置 null，
  // 所以此处不需要再判 assetCapabilities.chat_memory；tdaiClient 为 null 时自然跳过。
  if (ctx.tdaiClient && ctx.tdaiIdentity && isExtractionAllowed(ctx.config, "tdai-memory")) {
    trackWrite(
      withL0Retry(() =>
        recordTdaiTurn(ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage, assistantText || null),
      ).catch((err: unknown) => {
        console.warn("[workbuddy-tdai-l0] failed:", err instanceof Error ? err.message : String(err));
      }),
    );
  } else if (ctx.tdaiClient) {
    logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKey);
  }

  // ── Skill conversation/add trigger ──
  // 与 codexHandler 对称: 归档写完再返, 保证跨节点下一轮读到最新 buffer。
  // assistantMessage 使用 stream accumulator 的 outputText 组装一份
  // Responses API 格式的消息 (type:"message", role:"assistant",
  // content:[{type:"output_text", text}]) —— 与 codexHandler 一致。
  //
  // protocol 必须传 "responses"：server.ts 注释明确说明 WorkBuddy 与 Codex 同协议，
  // langfuse tag 也用 "protocol:responses"。若错传 "openai"，skill 提取时
  // normalizeConversation 会按 Chat Completions 格式解析 messages[]，
  // 与实际 body.input[] (Responses API) 错位。
  if (isExtractionAllowed(ctx.config, "skill")) {
    const assistantMessage = assistantText
      ? {
          type: "message" as const,
          role: "assistant" as const,
          content: [{ type: "output_text" as const, text: assistantText }],
        }
      : null;
    await triggerSkillExtractIfReady({
      config: ctx.config,
      sessionKey: ctx.sessionKey,
      agentSource: "workbuddy",
      sessionInfo: ctx.sessionInfo,
      inputMessages: ctx.input,
      assistantMessage,
      protocol: "responses",
      assetCapabilities: ctx.assetCapabilities,
      toolCallCountOverride,
    });
  } else {
    logExtractionSkipped(ctx.config, "skill", ctx.sessionKey);
  }
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
  const hasInput = Array.isArray(body.input);
  const hasInstructions =
    typeof body.instructions === "string" && (body.instructions as string).length > 0;
  if (!hasInput && !hasInstructions) return undefined;
  if (hasInput && hasInstructions) {
    return { input: body.input, instructions: body.instructions };
  }
  return hasInput ? body.input : { instructions: body.instructions };
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

function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((v, k) => {
    if (!SKIP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

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
  modelId: string,
  pipe: ReturnType<typeof createPipeline>,
  lf: LangfuseTurnContext | null,
  archiveCtx: WorkbuddyArchiveCtx | null = null,
): Promise<Response> {
  // ── Per-agent upstream override ──
  // 对齐 codexHandler: 支持 config.upstream.agents?.workbuddy 单独指 URL/apiKey，
  // 未配置时回退到全局 config.upstream.{url,apiKey}。
  const perAgent = (config.upstream as unknown as {
    agents?: { workbuddy?: { url?: string; apiKey?: string } };
  }).agents?.workbuddy;
  const upstreamBase = ((perAgent?.url ?? config.upstream.url ?? "") as string).replace(/\/$/, "");
  const upstreamPath = c.req.path.replace(/^\/workbuddy\/[^/]+/, "");
  const upstreamUrl = joinUrl(upstreamBase, upstreamPath);

  const headers = buildUpstreamHeaders(c, config);
  // 若 per-agent 指定了独立 apiKey，覆盖全局注入的 authorization
  if (perAgent?.apiKey) {
    headers["authorization"] = `Bearer ${perAgent.apiKey}`;
    delete headers["x-api-key"];
  }
  const bodyStr = JSON.stringify(body);

  // 结构化埋点：与 codex 对齐（forwardStart / forwardDone / info 三段式）
  pipe.forwardStart(upstreamUrl);

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

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: bodyStr,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pipe.info("WORKBUDDY_FORWARD_ERR", msg);
    // 网络层失败 → langfuse failure 上报，让线上可视化能看到
    if (lf) {
      try {
        langfuseReportFailure({
          lf,
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
  const contentType = upstreamResp.headers.get("content-type") ?? "";
  const isSSE = contentType.includes("text/event-stream");

  pipe.forwardDone(upstreamResp.status);

  // 上游 4xx/5xx → langfuse failure 上报（body 已被上游消费，不重读，避免破坏流）
  if (lf && upstreamResp.status >= 400) {
    try {
      langfuseReportFailure({
        lf,
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

  // Non-SSE or no langfuse ctx → passthrough
  if (!isSSE || !upstreamResp.body || !lf) {
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  }

  // SSE + langfuse: tee & tap
  const [passStream, tapStream] = upstreamResp.body.tee();
  void consumeWorkbuddyStream(tapStream, {
    startTime,
    modelId,
    keyId,
    traceId,
    lf,
    config,
    pipe,
    archiveCtx,
    inputBody: body,
    upstreamUrl,
  });

  return new Response(passStream, {
    status: upstreamResp.status,
    headers: respHeaders,
  });
}

/**
 * WorkBuddy tap context —— consumeWorkbuddyStream 的参数类型。
 */
interface WorkbuddyTapContext {
  startTime: string;
  modelId: string;
  keyId: string;
  traceId: string;
  lf: LangfuseTurnContext | null;
  config: ProxyConfig;
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
}

/**
 * Consume an SSE stream from upstream, extract text + usage, report to
 * langfuse, then trigger L0 write + skill extraction hooks.
 * Runs asynchronously without blocking the downstream response.
 *
 * 关键机制（对齐 codex 但保留 workbuddy 现有 try/finally 风格）：
 *   - 5 分钟兜底 setTimeout：客户端断开或上游卡住不释放时强制收尾一次
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
  // aux passthrough: skip langfuse + archive hooks
  if (!ctx.lf) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let assistantText = "";
  let usage: Record<string, unknown> | undefined;
  let responseId: string | undefined;
  // Q: 累积当前 turn 内的 function_call 次数（round 边界判据）
  let toolUseCount = 0;

  // P: 5 分钟超时兜底。上游或客户端断链可能让 reader.read() 一直挂起，
  // 用 setTimeout 强制 cancel，避免 tap coroutine 泄漏。用 flag 而不是
  // 直接 throw，因为 fetch 的 ReadableStream cancel 会让主循环自然退出。
  let streamCompleted = false;
  const timeoutHandle = setTimeout(() => {
    if (!streamCompleted) {
      ctx.pipe.error(
        "STREAM_TIMEOUT",
        new Error("Workbuddy stream reading exceeded 5 minutes"),
      );
      // 主动 cancel reader，读循环会因此收到 done=true 或 error 退出
      void reader.cancel().catch(() => {
        /* best-effort */
      });
    }
  }, 5 * 60 * 1000);

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
          }
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  } catch (err) {
    ctx.pipe.info("WORKBUDDY_STREAM_ERR", err instanceof Error ? err.message : String(err));
  } finally {
    streamCompleted = true;
    clearTimeout(timeoutHandle);
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  const endTime = new Date().toISOString();
  try {
    // R: 用结构化 input 上报（body.input + instructions），便于 langfuse UI 排障
    langfuseReportGeneration({
      traceId: ctx.lf.traceId,
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
export async function handleWorkbuddyEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const rawAuth = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  const rawXApiKey = c.req.header("x-api-key") ?? "";
  const apiKey =
    extractBearerToken(rawAuth) ??
    rawXApiKey ??
    "";
  const spaceId = extractSpaceIdFromPath(path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } = await verifyUserKey(
    apiKey,
    spaceId,
  );
  if (userKeyRejected) {
    return c.json({ error: `Authentication failed: ${rejectReason ?? "unknown"}` }, 401);
  }
  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");

  // ── 2. Read body ─────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── 3. Extract headers ───────────────────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
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
  const modelId = resolveModelId(config.creditPricing, requestedModel);
  const pipe = createPipeline(config, traceId, modelId);

  // ── 5. Aux passthrough ───────────────────────────────────────────────────
  if (isAuxiliary) {
    pipe.info("WORKBUDDY_AUX", `auxiliary request → passthrough (path=${path})`);
    return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, null, null);
  }

  // ── 6. Session ID + langfuse turn ctx ────────────────────────────────────
  const sessionId = extractWorkbuddySessionId(headers, body);
  const sessionKey = sessionId ?? `${keyId}:${traceId}`;
  const agentSource = "workbuddy";
  const isStream = body.stream !== false;
  const callerUserKey = apiKey || null;

  const turnSeq = countHumanTurnsWorkbuddy(body.input);
  const userQuery = workbuddyAdapter.extractUserText(body.input) ?? "";
  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(sessionKey, turnSeq),
    turnSeq,
    traceName: `${modelId} / ${keyId}`,
    userId: keyId,
    sessionId: sessionKey,
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
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook ──
  if (config.memCommand?.enabled) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { parseCommandFromText, isMemCommandAllowed } = await import("./mem-command/index.js");
      const { workbuddyAdapter } = await import("./agent-adapters/workbuddy.js");
      const userText = workbuddyAdapter.extractUserText(input) ?? "";
      const memCmd = parseCommandFromText(userText);
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `codex:${sessionKey}`;
        store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

        // ── 强制归档旧 agent 的 skill buffer（best-effort）──
        const oldState = store.get(compositeKey);
        if (oldState?.status === "initialized" && oldState.sessionInfo && config.coreSkill?.endpoint) {
          const si = oldState.sessionInfo as unknown as Record<string, string>;
          if (si.space_id && si.user_id && si.team_id && si.agent_id) {
            import("./skill/core-client.js").then(({ getCoreSkillClient }) => {
              const client = getCoreSkillClient(config.coreSkill!);
              client.forceArchive(
                {
                  space_id: si.space_id,
                  user_id: si.user_id,
                  team_id: si.team_id,
                  agent_id: si.agent_id,
                  session_id: sessionKey,
                  task_id: si.task_id || undefined,
                  reason: "session-reset",
                },
                { serviceId: si.space_id },
              ).then((res) => {
                console.log(`[session-reset] force-archive old buffer: status=${res.status} session=${sessionKey} agent=${si.agent_id}`);
              }).catch((err) => {
                console.warn(`[session-reset] force-archive failed (best-effort): ${err instanceof Error ? err.message : String(err)}`);
              });
            }).catch(() => {});
          }
        }

        const resetEpoch = Date.now();
        await store.set(compositeKey, { status: "uninitialized", keyId: sessionKey, startedAt: resetEpoch, attemptCount: 0, userId: userId || "anonymous", resetEpoch, resetFlow: true });
        const bindingRepo = store.getBindingRepo();
        if (bindingRepo) await bindingRepo.deleteBinding(spaceId, sessionKey).catch(() => {});
        console.log(`[mem-command:pre] session-reset session=${sessionKey} → falling through to pop form`);
      }
    }
  }

  if (config.sessionInit?.enabled && sessionId) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import(
        "./session/index.js"
      );
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      // kernel 侧鉴权的 x-tdai-user-key 直接用客户端请求 bearer（与 codexHandler / anthropicHandler 对齐）。
      // WorkBuddy / Codex / Claude Code 桌面客户端携带的 bearer 就是用户 key，kernel 能识别；
      // 无需 config.tdai.apiKey 兜底（否则 config 里的 "local" 会覆盖真实用户 key，导致 401）。
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, headers);

      const compositeKey = `codex:${sessionKey}`;
      const identity = {
        userId: userId || "anonymous",
        agentSource: "codex" as const,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        // Responses API 客户端不用 messages[]，传空由 store 走 header/no-message 回收路径
        messages: [],
      });

      let initResult: Awaited<ReturnType<typeof handleSessionInit>>;
      const isTerminalState = recovered?.status === "initialized";
      // Recovery hit source 决定是否需要 prewarm（详见 handler.ts 对称位置注释）。
      const needsPrewarm =
        recovered?.__recoverySource === "l2b" ||
        recovered?.__recoverySource === "history-scan";

      if (recovered && isTerminalState) {
        // Recovered from L2b/L2a — skip form, apply context
        const { buildSessionContextBlockWithToggles } = await import(
          "./session/context-injector.js"
        );
        const systemAppend = recovered.bypassed
          ? null
          : buildSessionContextBlockWithToggles(
              recovered.agentDetail ?? null,
              recovered.taskDetail ?? null,
              config.sessionInit,
              sessionKey,
            );
        initResult = {
          intercepted: false,
          messages: [],
          systemAppend,
          sessionInfo: recovered.sessionInfo,
          agentDetail: recovered.agentDetail,
          taskDetail: recovered.taskDetail,
          bypassed: recovered.bypassed,
          justRegistered: needsPrewarm,
        };
      } else {
        // Run the state machine — reuses CB's handleSessionInit with
        // agentSource="codex". CB parses picks from `messages[]`, but codex/workbuddy
        // clients send them as `function_call_output.output` items in body.input[]。
        // 我们用 codexFormAnswersAsMessages 把 output 合成成 minimal messages[]
        // 供 CB 的 extractor 识别（extractor 只看 last user/tool message text）。
        const synthesizedMessages = codexFormAnswersAsMessages(input);
        const rawOutputs = input
          .filter((it: any) => it?.type === "function_call_output")
          .map((it: any) => ({
            call_id: it.call_id,
            output_preview: String(it.output ?? "").slice(0, 200),
          }));
        if (rawOutputs.length > 0) {
          console.log(
            `[workbuddy-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synthesizedMessages).slice(0, 500)}`,
          );
        }
        initResult = await handleSessionInit(
          sessionKey,
          userId || null,
          synthesizedMessages,
          config.sessionInit,
          store,
          {
            stream: isStream,
            modelId: modelId as string,
            protocol: "responses" as any,
            // 把原始 input[] 交给 CB 状态机识别 Default gate 与 MORE 翻页
            codexAnswerInput: input,
          },
          "codex", // ← 状态机 source: 复用 codex 分支
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted) {
        // CB 状态机中断 → 用 codex form builder 渲染成 Responses API SSE 弹窗
        if (initResult.formData) {
          return buildCodexFormResponse({
            teams: initResult.formData.teams,
            stage: initResult.formData.stage,
            selectedTeamId: initResult.formData.selectedTeamId,
            selectedAgentId: initResult.formData.selectedAgentId,
            retry: initResult.formData.retry,
            teamPage: initResult.formData.teamPage ?? 0,
            agentPage: initResult.formData.agentPage ?? 0,
            taskPage: initResult.formData.taskPage ?? 0,
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        }
        // Defensive fallback
        if (initResult.response) return initResult.response;
      }

      // Default gate 首次命中 → 返一次 Plan 模式提示，后续同 session recovered.bypassed=true
      if ((initResult as any).bypassReason === "default-gate") {
        pipe.info("WORKBUDDY_GATE", "Default mode gate detected → notify user (first hit)");
        const { buildMemResponse } = await import("./mem-command/response-builder.js");
        // reset 场景下的 gate: 换成针对性文案,详见 codexHandler 同名段
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
      }

      if (initResult.bypassed) {
        injectionSkipped = true;
        console.log(
          `[workbuddy] session=${sessionKey} bypassed (reason=${(initResult as any).bypassReason ?? "unknown"}) → skipping injection`,
        );
        if (initResult.resetFlow) {
          _resetFlowResult = { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
        }
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
        try {
          const { fetchAssetCapabilities } = await import("./tdai/capabilities.js");
          assetCapabilities = await fetchAssetCapabilities({
            endpoint: config.tdai.endpoint,
            apiKey: config.tdai.apiKey,
            serviceId: config.tdai.serviceId,
            serviceIdOverride: spaceId,
            userId: (initResult.sessionInfo as { user_id?: string }).user_id,
            userKey: callerUserKey,
            timeoutMs: config.tdai.memory.timeoutMs,
          });
        } catch (err) {
          console.warn(
            `[workbuddy] asset-capability resolve failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Prewarm 前置短路：mem-command 命中的 turn 不走 forward、不消费 hook-cache，
      // 若照常 prewarm 会白花 2-3s + 3 次网络请求。见 handler.ts 对称位置详注。
      let memCommandPending = false;
      if (config.memCommand?.enabled) {
        try {
          const userTextPeek = workbuddyAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText, isMemCommandAllowed } = await import("./mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek && isMemCommandAllowed(config.memCommand, peek.command)) {
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

      if (
        !initResult.bypassed &&
        initResult.justRegistered &&
        initResult.sessionInfo &&
        !memCommandPending &&
        config.injection?.enabled &&
        (config.injection.injectors?.length ?? 0) > 0
      ) {
        try {
          const mod = await import("./injection/index.js");
          await mod.prewarmFromConfig(config, {
            keyId: sessionKey,
            userId: userId || "anonymous",
            agentSource,
            spaceId,
            sessionInfo: initResult.sessionInfo as import("./session/types.js").SessionInfo,
            agentDetail: initResult.agentDetail ?? null,
            taskDetail: initResult.taskDetail ?? null,
            assetCapabilities,
            callerUserKey: callerUserKey ?? undefined,
          }, { clearBefore: true });
        } catch (err) {
          console.warn(
            "[workbuddy] prewarm error:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      sessionInfo = initResult.sessionInfo as Record<string, unknown> | null | undefined;
      if (sessionInfo && !sessionInfo.space_id && spaceId) {
        sessionInfo.space_id = spaceId;
      }
      cachedAgentDetail = initResult.agentDetail ?? null;
      cachedTaskDetail = initResult.taskDetail ?? null;

      if (initResult.resetFlow && initResult.justRegistered && !initResult.bypassed) {
        _resetFlowResult = {
          agentName: initResult.agentDetail?.name ?? "未知",
          agentIdShort: (initResult.sessionInfo as unknown as Record<string, unknown>)?.agent_id
            ? String((initResult.sessionInfo as unknown as Record<string, unknown>).agent_id).slice(-8) : "",
          teamId: (initResult.sessionInfo as unknown as Record<string, unknown>)?.team_id
            ? String((initResult.sessionInfo as unknown as Record<string, unknown>).team_id).slice(-8) : "",
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

  // ── mem:session-reset 完成确认 ─────────────────────────────────────────────
  if (_resetFlowResult) {
    const { agentName, agentIdShort, teamId, taskName, bypassed } = _resetFlowResult;
    const lines = bypassed
      ? ["✅ 已跳过团队资产关联", "", "后续对话不注入任何团队资产（Skill / 记忆 / Knowledge）。"]
      : [
          "✅ 已重新绑定团队资产",
          "",
          `- **Agent**: ${agentName}${agentIdShort ? ` (${agentIdShort})` : ""}`,
          teamId ? `- **Team**: ${teamId}` : null,
          taskName ? `- **Task**: ${taskName}` : "- **Task**: 未关联",
          "",
          "后续对话将使用新 Agent 的 Skill、记忆和知识资产。",
        ].filter(Boolean);
    const text = (lines as string[]).join("\n");

    const { buildMemResponse } = await import("./mem-command/response-builder.js");
    console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort})`);
    return buildMemResponse(text, {
      protocol: "responses",
      stream: isStream,
      requestId: `mem-reset-${Date.now()}`,
    });
  }

  // ── 8. mem-command intercept ────────────────────────────────────────────
  if (config.memCommand?.enabled) {
    const userText = workbuddyAdapter.extractUserText(input);
    if (userText) {
      const { parseCommandFromText, isMemCommandAllowed, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } =
        await import("./mem-command/index.js");
      // ⚠️ 不用 parseMemCommand(body, "workbuddy") —— 它只解 body.messages[] (CC/CB 形态),
      // WorkBuddy 用的是 Responses API (body.input[])，传进去永远返 null → 命令静默透传给 LLM。
      // 改用 parseCommandFromText(userText) 直接解析用户文本。对齐 codexHandler 的做法。
      let memCmd = parseCommandFromText(userText);
      // session-reset 已由 pre-hook 处理，跳过防止重复执行
      if (memCmd?.command === "session-reset") memCmd = null;
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        if (!sessionInfo || injectionSkipped) {
          const errText = `⚠️ 会话未初始化，命令不可用。请先完成 session 初始化（选择 Team/Agent）后重试。`;
          const errResponse = buildMemResponse(errText, {
            protocol: "responses",
            stream: isStream,
            requestId: `mem-cmd-${Date.now()}`,
          });
          console.log(
            `[workbuddy] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`,
          );
          return errResponse;
        }
        pipe.info("WORKBUDDY_MEM_CMD", `mem command intercepted: ${memCmd.command}`);
        const memResult = await executeMemCommand(memCmd, {
          sessionKey,
          agentSource: "workbuddy",
          config,
          spaceId,
          userId: userId || "",
          apiKey: apiKey || "",
          sessionInfo: sessionInfo as Record<string, unknown>,
          // ⚠️ WorkBuddy 走 Responses API，与 codex 同协议。传 "responses"，
          // executeMemCommand 内部会用对应的 responses SSE 骨架渲染命令响应。
          protocol: "responses",
          stream: isStream,
          args: memCmd.args,
          // task 命令族用最近对话生成草稿。Responses API body.input[] 结构：
          //   { type:"message", role, content:[{type:"input_text"|"output_text", text}] }
          // extractSimpleMessages 已内置对该形态的识别，转成 {role, content} 极简格式。
          bodyMessages: extractSimpleMessages(input),
        });

        // ── TDAI L0 write + Skill extraction (fire-and-forget) ──
        // 对齐 codexHandler 的 mem-command 后归档逻辑: 命令执行结果不阻塞响应,
        // 异步触发 L0 write + skill 提取 + langfuse 上报。
        //
        // assistantText 用 memResult.messageText (proxy 给用户的命令响应), 不是
        // userText (用户输入的命令) —— L0 write 把"用户问了什么 / 系统答了什么"
        // 配对写入, 用 userText 当 assistant 会颠倒语义。
        const memArchiveCtx = buildWorkbuddyArchiveCtx({
          config,
          sessionInfo,
          injectionSkipped,
          input,
          sessionKey,
          userId: userId || "",
          callerUserKey,
          assetCapabilities,
        });
        if (memArchiveCtx) {
          void triggerWorkbuddyArchiveHooks(memArchiveCtx, memResult.messageText ?? "").catch((err: unknown) => {
            pipe.info(
              "WORKBUDDY_MEM_ARCHIVE_ERR",
              err instanceof Error ? err.message : String(err),
            );
          });
        }

        // ── Langfuse report for mem-command ──
        const endTime = new Date().toISOString();
        try {
          langfuseReportGeneration({
            traceId: lf.traceId,
            name: `workbuddy:${modelId}:mem-${memCmd.command}`,
            model: modelId,
            startTime: startTime,
            endTime,
            input: userText ?? undefined,
            output: memResult.messageText ?? "OK",
            usage: undefined,
            traceName: lf.traceName,
            userId: lf.userId,
            sessionId: lf.sessionId,
            tags: [...lf.tags, `mem_cmd:${memCmd.command}`],
            traceInput: userText ?? undefined,
            traceOutput: memResult.messageText ?? "OK",
            observationMetadata: {
              mem_command: memCmd.command,
              protocol: "responses",
            },
          });
        } catch (err: unknown) {
          pipe.info(
            "WORKBUDDY_MEM_LANGFUSE_ERR",
            err instanceof Error ? err.message : String(err),
          );
        }

        console.log(
          `[workbuddy] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`,
        );
        return memResult.response;
      }
    }
  }

  // ── 9. Asset injection (每轮都跑) ────────────────────────────────────────
  if (
    !injectionSkipped &&
    sessionInfo &&
    config.injection?.enabled &&
    (config.injection.injectors?.length ?? 0) > 0
  ) {
    try {
      const { getInjectionPipeline } = await import("./injection/index.js");
      const pipeline = getInjectionPipeline(config);
      const { buildSessionContextBlockWithToggles } = await import(
        "./session/context-injector.js"
      );
      const sessionContextBlock = buildSessionContextBlockWithToggles(
        cachedAgentDetail as import("./session/types.js").AgentDetail | null,
        cachedTaskDetail as import("./session/types.js").TaskDetail | null,
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
  return forwardToUpstream(c, config, body, traceId, startTime, keyId, modelId, pipe, lf, archiveCtx);
}
