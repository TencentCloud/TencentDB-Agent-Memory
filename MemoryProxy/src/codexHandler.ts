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
import type { ProxyConfig } from "./types.js";
import { apiKeyToKeyId, extractBearerToken, uuidv7 } from "./opik.js";
import { createPipeline, writeLog } from "./logger.js";
import { extractSpaceIdFromPath } from "./credit-reporter.js";
import { joinUrl } from "./guard-adapter.js";
import { verifyUserKey } from "./auth.js";
import { resolveModelId } from "./pricing.js";
import { codexAdapter } from "./agent-adapters/codex.js";
import {
  DEFAULT_GATE_PREFIX,
  buildFormResponse as buildCodexFormResponse,
  codexFormAnswersAsMessages,
} from "./session/codex/form.js";
import { buildCodexInjectionBlock, type CodexInjectionInput } from "./common/codex-injection.js";
import { log } from "./report/log.js";
import {
  langfuseReportGeneration,
  langfuseReportFailure,
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "./langfuse.js";
import { TdaiClient } from "./tdai/client.js";
import { deriveTdaiIdentity } from "./tdai/identity.js";
import { recordTdaiTurn } from "./tdai/recorder.js";
import { trackWrite, withL0Retry } from "./tdai/pending-writes.js";
import type { TdaiIdentity, TdaiMessage } from "./tdai/types.js";
import { triggerSkillExtractIfReady } from "./skill/handler-glue.js";
import { isExtractionAllowed, logExtractionSkipped } from "./extraction-gate.js";

// ── Constants ────────────────────────────────────────────────────────────────

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

// ── TDAI L0 helpers (对齐 anthropicHandler / handler 姿势) ───────────────────

/**
 * TDAI L0 客户端工厂 —— 跟 anthropicHandler.ts::createTdaiClient 语义一致。
 * spaceId 优先于 config 默认 serviceId, 便于多租户下 codex 请求上报到正确的
 * kernel 实例。config.tdai.memory.enabled=false 时返 null。
 */
function createCodexTdaiClient(config: ProxyConfig, spaceId?: string): TdaiClient | null {
  if (!config.tdai.enabled || !config.tdai.memory.enabled || !config.tdai.endpoint) return null;
  return new TdaiClient({
    enabled: config.tdai.enabled && config.tdai.memory.enabled,
    endpoint: config.tdai.endpoint,
    apiKey: config.tdai.apiKey,
    serviceId: spaceId || config.tdai.serviceId,
    writeL0: config.tdai.memory.writeL0,
    recallL1: config.tdai.memory.recallL1,
    injectL2L3: config.tdai.memory.injectL2L3,
    l1Limit: config.tdai.memory.l1Limit,
    l2Limit: config.tdai.memory.l2Limit,
    timeoutMs: config.tdai.memory.timeoutMs,
  });
}

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
 */
export function extractCodexSessionId(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): string | null {
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

function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * Codex endpoint handler.
 *
 * Routes internally:
 *   - aux endpoints → lightweight passthrough
 *   - main /v1/responses → full pipeline (session-init, injection, mem-command, forward)
 */
export async function handleCodexEndpoint(
  c: Context,
  config: ProxyConfig,
): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();
  const path = c.req.path;

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const apiKey =
    extractBearerToken(c.req.header("authorization") ?? c.req.header("Authorization") ?? "") ??
    c.req.header("x-api-key") ??
    "";

  const spaceId = extractSpaceIdFromPath(path) ?? "";
  const { userId, rejected: userKeyRejected, rejectReason } =
    await verifyUserKey(apiKey, spaceId);
  if (userKeyRejected) {
    return c.json(
      { error: `Authentication failed: ${rejectReason ?? "unknown"}` },
      401,
    );
  }

  const keyId = userId || (apiKey ? apiKeyToKeyId(apiKey) : "unknown");

  // ── 2. Read body ───────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // ── 3. Extract headers as plain object ─────────────────────────────────────
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    headers[k.toLowerCase()] = v;
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
  const modelId = resolveModelId(config.creditPricing, requestedModel);

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
  const turnSeq = countHumanTurnsCodex(body.input);
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

  // ── 7. Session-init state machine ──────────────────────────────────────────
  let sessionInfo: Record<string, unknown> | null | undefined;
  let assetCapabilities: import("./injection/types.js").AssetCapabilityFlags | undefined;
  let injectionSkipped = false;
  let sessionJustRegistered = false;
  let _resetFlowResult: { agentName: string; agentIdShort: string; teamId: string; taskName?: string | null; bypassed?: boolean } | null = null;
  // 存 initResult 的 agent/task detail 供 § 9 注入阶段构造 <session_context>。
  // handleSessionInit 内部本会通过 messages[0] 塞进 session_context，但那份
  // messages 是我们传进去的临时 synthesizedMessages，不会回到 codex body。
  // 这里显式抓 detail，让下面合成 body 时用 buildSessionContextBlockWithToggles
  // 造同款 block 并预填到合成 system message 前面。
  let cachedAgentDetail: unknown = null;
  let cachedTaskDetail: unknown = null;

  const input = Array.isArray(body.input) ? body.input : [];

  // ── mem:session-reset pre-hook ──
  if (config.memCommand?.enabled) {
    const { isSessionResetCommand } = await import("./mem-command/pre-intercept.js");
    if (isSessionResetCommand(body as Record<string, unknown>, agentSource)) {
      const { parseCommandFromText, isMemCommandAllowed } = await import("./mem-command/index.js");
      const { codexAdapter } = await import("./agent-adapters/codex.js");
      const userText = codexAdapter.extractUserText(input) ?? "";
      const memCmd = parseCommandFromText(userText);
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        const { getSessionStore } = await import("./session/store.js");
        const store = getSessionStore();
        const compositeKey = `${agentSource}:${sessionKey}`;
        store.bind(compositeKey, { userId: userId || "anonymous", agentSource, sessionId: sessionKey, spaceId });

        // ── 强制归档旧 agent 的 skill buffer（best-effort）──
        const oldState = store.get(compositeKey);
        if (oldState?.status === "initialized" && oldState.sessionInfo && config.coreSkill?.endpoint) {
          const si = oldState.sessionInfo as Record<string, string>;
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

  // ── 7. Session-init state machine (reuses CB with agentSource="codex") ────
  //
  // 老版本 7a (Default gate 独立拦截) + 7b.1 (MORE 独立拦截) 已收敛进 CB 状态机内部
  // (session/codebuddy/init.ts 顶部 codex-only pre-checks 段)。codexHandler 只
  // 负责把 body.input[] 透传给 reqCtx.codexAnswerInput 让状态机自己识别 gate/MORE。
  // 首次 Default gate 命中会拿到 initResult.bypassReason === "default-gate", 由
  // 本 handler 返一次 Plan 模式提示；后续同 session 请求 bypass 稳态透传。
  if (config.sessionInit?.enabled && sessionId) {
    try {
      const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import("./session/index.js");
      const { getMetadataClient } = await import("./meta/client.js");
      const store = getSessionStore();
      const metadataClient = getMetadataClient(config.coreSkill, spaceId, apiKey);
      const presetIdentity = parsePresetIdentity(config.sessionInit, headers);

      const compositeKey = `${agentSource}:${sessionKey}`;
      const identity = {
        userId: userId || "anonymous",
        agentSource,
        sessionId: sessionKey,
        spaceId,
      };
      const recovered = await store.getOrRecover(compositeKey, identity, {
        metadataClient,
        // Codex doesn't use messages[] — pass empty for recovery.
        // History-scan fallback won't find form markers but will
        // produce a one-shot bypass for existing conversations.
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
        const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
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
        // Run the state machine — codex reuses CB's handleSessionInit
        // with agentSource="codex". CB parses answers from `messages[]`, but
        // codex clients send answers as `function_call_output.output` items in
        // `body.input[]`. We synthesize a minimal `messages[]` array from those
        // outputs so CB's extractors (which look at the last user/tool message
        // text) find the pick verbatim. See session/codex/form.ts::codexFormAnswersAsMessages.
        const synthesizedMessages = codexFormAnswersAsMessages(input);
        // DEBUG: dump function_call_output raw text so we can tell whether the
        // client shows the form to the user (real answer) vs auto-fills (model-
        // generated answer). Also dump the extracted answers.
        const rawOutputs = input
          .filter((it: any) => it?.type === "function_call_output")
          .map((it: any) => ({ call_id: it.call_id, output_preview: String(it.output ?? "").slice(0, 200) }));
        if (rawOutputs.length > 0) {
          console.log(`[codex-debug] session=${sessionKey} function_call_outputs=${JSON.stringify(rawOutputs)} synth_msgs=${JSON.stringify(synthesizedMessages).slice(0, 500)}`);
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
            // 把原始 input[] 交给 CB 状态机，用于识别 codex 客户端专属的
            // Default gate 字符串和 MORE 翻页标记。
            codexAnswerInput: input,
          },
          agentSource,
          metadataClient,
          apiKey,
          spaceId,
          presetIdentity,
        );
      }

      if (initResult.intercepted) {
        // CB state machine intercepted → 直接用它已经带上 pageIndex 的
        // formData 通过 codex builder 重渲染成 Responses API SSE。CB 状态机
        // 内部会在 codex source 时把 latest state.codexPageIndex 塞进
        // formData.{teamPage,agentPage,taskPage}。
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
            // Override stream with the current request's stream flag — the CB
            // FormData carries the value from when the form was first built,
            // but codex clients pass a fresh stream setting each turn.
            stream: isStream,
            modelId: initResult.formData.modelId ?? (modelId as string),
          });
        }
        // Defensive fallback: no formData → intercept without a form response
        // (should be unreachable now that every CB intercepted return sets it).
        if (initResult.response) return initResult.response;
      }

      // ── Default gate 首次命中：CB 状态机已经落 bypass state，本 handler
      //    返一次 Plan 模式提示；下一轮请求 recovered.bypassed=true 会走
      //    initialized 分支直接透传，Plan 提示不会再重复。
      if ((initResult as any).bypassReason === "default-gate") {
        pipe.info("CODEX_GATE", "Default mode gate detected → notify user (first hit)");
        const { buildMemResponse } = await import("./mem-command/response-builder.js");
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
      if (initResult.bypassed) {
        injectionSkipped = true;
        console.log(`[codex] session=${sessionKey} bypassed → skipping all injection`);
        if (initResult.resetFlow) {
          _resetFlowResult = { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
        }
      }

      if (!initResult.bypassed && initResult.sessionInfo) {
        // Fetch asset capabilities for this session
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
          console.warn(`[codex] asset-capability resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Prewarm 前置短路：mem-command 命中的 turn 不走 forward、不消费 hook-cache，
      // 若照常 prewarm 会白花 2-3s + 3 次网络请求。见 handler.ts 对称位置详注。
      let memCommandPending = false;
      if (config.memCommand?.enabled) {
        try {
          const userTextPeek = codexAdapter.extractUserText(input);
          if (userTextPeek) {
            const { parseCommandFromText, isMemCommandAllowed } = await import("./mem-command/index.js");
            const peek = parseCommandFromText(userTextPeek);
            if (peek && isMemCommandAllowed(config.memCommand, peek.command)) {
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
          console.warn("[codex] prewarm error:", err instanceof Error ? err.message : String(err));
        }
      }

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
          agentIdShort: (initResult.sessionInfo as Record<string, unknown>)?.agent_id
            ? String((initResult.sessionInfo as Record<string, unknown>).agent_id).slice(-8) : "",
          teamId: (initResult.sessionInfo as Record<string, unknown>)?.team_id
            ? String((initResult.sessionInfo as Record<string, unknown>).team_id).slice(-8) : "",
          taskName: initResult.taskDetail?.name,
        };
      }
    } catch (err: unknown) {
      console.error("[codex] session-init error:", err instanceof Error ? err.message : String(err));
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

  // ── 8. mem-command intercept ────────────────────────────────────────────────
  // Position: after session-init, before injection (same as CC/CB).
  //
  // ⚠️ 不走 parseMemCommand(body, ...) —— 该函数只解 body.messages[] (CC/CB
  // 形态)，codex body 用 input[]，进去立即返 null → mem 命令全部静默透传给
  // LLM，模型会编造"Memory synced" 之类假回复 (P0-1 QA 报告)。
  // 直接用已提取的 userText 走 parseCommandFromText。
  if (config.memCommand?.enabled) {
    const userText = codexAdapter.extractUserText(input);
    if (userText) {
      const { parseCommandFromText, isMemCommandAllowed, executeMemCommand, buildMemResponse, extractSimpleMessages, truncateArgs } =
        await import("./mem-command/index.js");
      let memCmd = parseCommandFromText(userText);
      // session-reset 已由 pre-hook 处理，跳过防止重复执行
      if (memCmd?.command === "session-reset") memCmd = null;
      if (memCmd && isMemCommandAllowed(config.memCommand, memCmd.command)) {
        // Session not initialized → command not available
        if (!sessionInfo || injectionSkipped) {
          const errText = `⚠️ 会话未初始化，命令不可用。请先完成 session 初始化（选择 Team/Agent）后重试。`;
          const errResponse = buildMemResponse(errText, {
            protocol: "responses",
            stream: isStream,
            requestId: `mem-cmd-${Date.now()}`,
          });
          console.log(`[codex] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} blocked: session not initialized`);
          return errResponse;
        }
        pipe.info("CODEX_MEM_CMD", `mem command intercepted: ${memCmd.command}`);
        const memResult = await executeMemCommand(memCmd, {
          sessionKey,
          agentSource: "codex",
          config,
          spaceId,
          userId: userId || "",
          apiKey: apiKey || "",
          sessionInfo: sessionInfo as Record<string, unknown>,
          protocol: "responses",
          stream: isStream,
          args: memCmd.args,
          // task 命令族用最近对话生成草稿。Responses API body.input[] 结构：
          //   { type:"message", role, content:[{type:"input_text"|"output_text", text}] }
          // extractSimpleMessages 已内置对该形态的识别，转成 {role, content} 极简格式。
          bodyMessages: extractSimpleMessages(input),
        });

        // ── L0 写入（同步 await，跟 CC/CB mem 命令路径对齐）──
        //   mem 命令是此 turn 唯一的落盘机会，不能 fire-and-forget (trackWrite)，
        //   必须显式等待落盘后再返回，避免进程未 flush 就退出导致丢失。
        const tdaiClientForMem = createCodexTdaiClient(config, spaceId);
        const tdaiIdentityForMem = deriveTdaiIdentity({
          sessionInfo: sessionInfo as Record<string, unknown> | null | undefined,
          userId: userId || null,
          sessionKey,
          userKey: callerUserKey,
        });
        if (tdaiClientForMem && tdaiIdentityForMem && isExtractionAllowed(config, "tdai-memory")) {
          const userMsg = { role: "user" as const, content: memCmd.rawMessage };
          try {
            await recordTdaiTurn(tdaiClientForMem, tdaiIdentityForMem, userMsg, memResult.messageText);
          } catch (err: unknown) {
            console.error("[codex] mem-command L0 write error:", err);
          }
        }

        // ── Skill extract（同步 await，保证对话轮次计数正常累积）──
        if (isExtractionAllowed(config, "skill")) {
          try {
            const assistantMessage = {
              type: "message" as const,
              role: "assistant" as const,
              content: [{ type: "output_text" as const, text: memResult.messageText }],
            };
            await triggerSkillExtractIfReady({
              config,
              sessionKey,
              agentSource: "codex",
              sessionInfo: sessionInfo as Record<string, unknown>,
              inputMessages: input,
              assistantMessage,
              protocol: "responses",
              assetCapabilities,
            });
          } catch (err: unknown) {
            console.warn("[codex] mem-command skill extract trigger error:", err instanceof Error ? err.message : String(err));
          }
        }

        // ── Langfuse: 上报 mem-command generation ──
        //   codex handler 的 lf 在 mem 命令块之前已构造 (line 366)，直接复用。
        langfuseReportGeneration({
          traceId: lf.traceId,
          name: "memory-proxy",
          model: "memory-proxy",
          startTime,
          endTime: new Date().toISOString(),
          input: userText,
          output: memResult.messageText,
          usage: { input_tokens: 0, output_tokens: 0 },
          traceName: `memory-proxy / ${keyId}`,
          userId: lf.userId,
          sessionId: lf.sessionId,
          tags: [...lf.tags, "mem-command"],
          traceInput: userText,
          traceOutput: memResult.messageText,
        });

        console.log(`[codex] mem-command cmd=${memCmd.command} args="${truncateArgs(memCmd.args)}" session=${sessionKey} success=${memResult.success}`);
        return memResult.response;
      }
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
      const { getInjectionPipeline } = await import("./injection/index.js");
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
      const { buildSessionContextBlockWithToggles } = await import("./session/context-injector.js");
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
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
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
  assetCapabilities?: import("./injection/types.js").AssetCapabilityFlags;
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
 */
async function triggerCodexArchiveHooks(
  ctx: CodexArchiveCtx,
  assistantText: string,
  toolUseCount: number,
): Promise<void> {
  // ── TDAI L0 write ──
  // 与 anthropicHandler stream 分支 (line 1867-1878) 对称:
  //   - trackWrite 挂全局 in-flight set (index.ts flushPendingWrites 兜底 SIGTERM 丢包)
  //   - withL0Retry 3 次退避挡 tdai kernel 瞬断
  //   - stream 场景不 await, 让归档 hook 提前返回
  if (ctx.tdaiClient && ctx.tdaiIdentity && isExtractionAllowed(ctx.config, "tdai-memory")) {
    trackWrite(
      withL0Retry(() =>
        recordTdaiTurn(ctx.tdaiClient!, ctx.tdaiIdentity, ctx.tdaiUserMessage, assistantText || null),
      ).catch((err: unknown) => {
        console.warn("[codex-tdai-l0] failed:", err instanceof Error ? err.message : String(err));
      }),
    );
  } else if (ctx.tdaiClient) {
    logExtractionSkipped(ctx.config, "tdai-memory", ctx.sessionKey);
  }

  // ── Skill conversation/add trigger ──
  // 与 anthropicHandler stream 分支 (line 1928-1948) 对称: 归档写完再返, 保证
  // 跨节点下一轮读到最新 buffer 状态; assistantMessage 用 stream accumulator 的
  // outputText 拼一份 codex message 形态 (type:"message", role:"assistant",
  // content:[{type:"output_text", text}]), toolCallCountOverride 由 stream 计数。
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
      agentSource: ctx.agentSource,
      sessionInfo: ctx.sessionInfo,
      inputMessages: ctx.input,
      assistantMessage,
      protocol: "responses",
      assetCapabilities: ctx.assetCapabilities,
      toolCallCountOverride: toolUseCount,
    });
  } else {
    logExtractionSkipped(ctx.config, "skill", ctx.sessionKey);
  }
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
  const upstreamBase = agentUpstreamEntry?.url || config.upstream.url;
  const upstreamUrl = joinUrl(upstreamBase, c.req.path);
  const upstreamHeaders = buildUpstreamHeaders(c, config);
  upstreamHeaders["content-type"] = "application/json";
  // 覆盖 apiKey 与 per-agent 策略一致：agentUpstreamEntry.apiKey 优先，
  // 否则透传客户端 Bearer。
  if (agentUpstreamEntry) {
    if (agentUpstreamEntry.apiKey) {
      upstreamHeaders["authorization"] = `Bearer ${agentUpstreamEntry.apiKey}`;
    }
    // else: 保留 c.req.header('authorization') 里的客户端 key 透传
  }

  pipe.forwardStart(upstreamUrl);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    pipe.error("CODEX_FORWARD", err instanceof Error ? err : new Error(String(err)));
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

  pipe.forwardDone(upstreamResp.status);

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

  // 2xx: aux 场景 (lf=null && archiveCtx=null) 直接透传不 tap; 主对话场景 tap
  // 一份用于 langfuse 上报 + skill/L0 归档 hook (P1-P2 gap 修复)。
  // 只要有 lf 或 archiveCtx 任一非空就必须 tee 一份 tap 流。
  const needTap = Boolean(lf) || Boolean(archiveCtx);
  if (!needTap || !upstreamResp.body) {
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  const [rawClientStream, tapStream] = upstreamResp.body.tee();
  consumeCodexStream(tapStream, {
    lf,
    modelId,
    startTime,
    upstreamUrl,
    inputBody: body,
    pipe,
    archiveCtx,
  });

  return new Response(rawClientStream, {
    status: upstreamResp.status,
    headers: filterResponseHeaders(upstreamResp.headers),
  });
}

// ── Langfuse helpers ─────────────────────────────────────────────────────────

/**
 * 从 codex `body.input[]` 里推导 turn 序号 —— 数 role=user 的 message 项数量。
 *
 * 与 turnSeq.ts::countHumanTurns(openai/anthropic) 对齐：同 turn 内工具循环
 * 请求（新增 function_call_output 项）不会增加人类 message，因此得到相同的
 * turnSeq，多个请求归并到同一个 langfuse trace。
 */
export function countHumanTurnsCodex(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let count = 0;
  for (const item of input) {
    const it = item as Record<string, unknown> | null;
    if (!it || typeof it !== "object") continue;
    if (it.type === "message" && it.role === "user") count++;
  }
  return count;
}

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
              stopReason = (resp?.status as string) ?? "completed";
            } else if (evtType === "response.incomplete") {
              // max_output_tokens / 其它中断（Responses API 标准）
              const resp = evt.response as Record<string, unknown> | undefined;
              const details = resp?.incomplete_details as Record<string, unknown> | undefined;
              stopReason = `incomplete:${details?.reason ?? "unknown"}`;
              if (resp?.usage) Object.assign(usage, resp.usage as Record<string, unknown>);
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
