/**
 * stages/session-init-orchestrate.ts — session-init 主编排 stage。
 *
 * 抽自 4 runner 里 ~200 行同构骨架 (openai-chat / anthropic / codex / workbuddy):
 *   1. store / metadataClient / parsePresetIdentity 组装 (完全相同)
 *   2. compositeKey + identity 组装 (workbuddy 硬编码 codex: 前缀 — 参数化)
 *   3. store.getOrRecover (完全相同)
 *   4. isTerminalState + needsPrewarm 判断 (完全相同)
 *   5. recover branch: buildSessionContextBlockWithToggles / injectSessionContextWithToggles
 *      → 组装 initResult 里的 messages/systemAppend (protocol 差, 由 recoverApplyFn 参数化)
 *   6. handleSessionInit 主状态机调用 (完全相同; reqCtx protocol/questionsAsArray/codexAnswerInput
 *      参数由 caller 通过 buildReqCtx 提供; agentSource 也参数化 —— workbuddy 用 "codex")
 *   7. intercept response 组装 (protocol 差, 由 buildInterceptResponse 参数化;
 *      openai/anthropic 用 initResult.response, codex/wb 走 buildCodexFormResponse)
 *   8. Default-gate 分支 (codex/wb 独有 — 由 caller 通过 buildDefaultGateResponse 可选传入)
 *
 * 差异保留为 4 个 callback 参数, 每个 runner 自己给:
 *   - synthesizeMessages: (body) => Record<string,unknown>[]
 *     * openai-chat: body.messages 原样
 *     * anthropic: body.messages 原样
 *     * codex/wb: codexFormAnswersAsMessages(input)
 *   - buildRecoverInitResult: (recovered) => Partial<SessionInitResult>
 *     * openai-chat: injectSessionContextWithToggles → messages
 *     * anthropic/codex/wb: buildSessionContextBlockWithToggles → systemAppend
 *   - buildInterceptResponse: (initResult) => Response | null
 *     * openai-chat/anthropic: 直接 initResult.response
 *     * codex/wb: 用 formData → buildCodexFormResponse
 *   - buildDefaultGateResponse?: (initResult) => Response | null
 *     * codex/wb 独有; openai-chat/anthropic 传 undefined
 *
 * ForkSideQuery 短路 (anthropic 独有 requestKind==="fork" L2b miss → passthrough):
 *   - fork 分支由 caller 前置判断, 命中直接 no-op 返 initResult, 不进本 stage;
 *     或本 stage 提供 forkPassthrough 选项让 caller 传入 requestKind + branch。
 *   - 当前简单起见: fork 分支保留在 caller (anthropic runner) 里, 因它只 1 处独有。
 *
 * 每个 runner 的调用姿势 (伪代码):
 *   const { proceed, response, initResult, wentThroughStateMachine } = await stageSessionInitOrchestrate({
 *     agentSourceForState, sessionKey, userId, config, headers, spaceId,
 *     apiKey, body, isStream, modelId, capabilities,
 *     compositeKeyOverride: (wb 传 "codex:...", 其他传 undefined),
 *     synthesizeMessages, buildRecoverInitResult, buildInterceptResponse,
 *     buildDefaultGateResponse, // codex/wb
 *     buildReqCtx, // protocol + questionsAsArray + codexAnswerInput
 *   });
 *   if (!proceed) return response!;
 *   // caller 继续用 initResult 走 apply / prewarm / archive-ctx 等
 */

import type {
  SessionInitConfig,
  ProxyConfig,
} from "../../types.js";
import type {
  SessionStore,
  SessionInitResult,
  SessionRequestContext,
} from "../../session/index.js";
import type { PresetIdentity } from "../../session/preset.js";
import type { MetadataClient } from "../../meta/client.js";

/** Recover 命中时由 caller 自定的 initResult 构造 (protocol 特化); 可 async 以便 caller dynamic import */
export type RecoverApplyFn = (
  recovered: NonNullable<Awaited<ReturnType<SessionStore["getOrRecover"]>>>,
  bodyMessages: Array<Record<string, unknown>>,
) => (Partial<SessionInitResult> & { messages?: Array<Record<string, unknown>>; systemAppend?: unknown })
  | Promise<Partial<SessionInitResult> & { messages?: Array<Record<string, unknown>>; systemAppend?: unknown }>;

/** 拦截时的 Response 组装 (openai/anthropic 直接返 initResult.response; codex/wb 组装 formResponse) */
export type BuildInterceptFn = (initResult: SessionInitResult) => Response | null;

/** Default-gate 分支 (codex/wb 独有; openai/anthropic 传 undefined) */
export type BuildDefaultGateFn = (initResult: SessionInitResult) => Response | null;

/** 用户消息合成: openai/anthropic 直接返 body.messages, codex/wb 返 codexFormAnswersAsMessages(input) */
export type SynthesizeMessagesFn = () => Array<Record<string, unknown>>;

/** SessionRequestContext 构造 (protocol / questionsAsArray / codexAnswerInput / capabilities) */
export type BuildReqCtxFn = () => SessionRequestContext;

export interface SessionInitOrchestrateInput {
  /** 状态机分派的 agentSource (workbuddy 传 "codex" 复用 CB 分支) */
  agentSourceForState: string;
  /** compositeKey 前缀; wb 传 "codex:..." (借用 codex L2b binding), 其他传 undefined 走 agentSource */
  compositeKeyOverride?: string;
  sessionKey: string;
  userId: string | null;
  spaceId?: string;
  config: ProxyConfig & { sessionInit: SessionInitConfig };
  /** kernel /v3/meta 鉴权用 sk-mem-* key; openai-chat 用 `apiKey || config.tdai.apiKey`, 其他用 apiKey */
  kernelUserKey: string;
  /** 请求 header lowercased map, 供 parsePresetIdentity 用 */
  headers: Record<string, string>;
  /** 用户消息合成 (openai/anthropic body.messages / codex/wb codexFormAnswersAsMessages) */
  synthesizeMessages: SynthesizeMessagesFn;
  /** recover 命中时 initResult protocol-specific 组装 */
  buildRecoverInitResult: RecoverApplyFn;
  /** state machine 的 reqCtx (protocol + questionsAsArray + codexAnswerInput + capabilities + stream + modelId) */
  buildReqCtx: BuildReqCtxFn;
  /** intercept response protocol-specific 组装 */
  buildInterceptResponse: BuildInterceptFn;
  /** Default-gate 首次命中的 Plan 提示响应 (codex/wb 独有); undefined 表示不检查此分支 */
  buildDefaultGateResponse?: BuildDefaultGateFn;
  /** L2b recovery 时是否传 messages 给 store (openai/anthropic 传 body.messages, codex/wb 传 []) */
  recoveryMessages: Array<Record<string, unknown>>;
  /**
   * anthropic 独有: requestKind === "fork" 且 recover 未命中终态时短路 passthrough。
   * 传入的函数在 store.getOrRecover 后, isTerminalState 判断前被调用;
   * 若返回非 null 就直接用返回的 initResult 短路 (跳过 recover/state-machine 分支)。
   *
   * 老 anthropic runner 的语义 (行为等价保留):
   *   if (requestKind === "fork" && !recovered?.status !== "initialized") → passthrough
   */
  forkPassthroughHook?: (recovered: Awaited<ReturnType<SessionStore["getOrRecover"]>>) => SessionInitResult | null;
}

export interface SessionInitOrchestrateResult {
  /** false → response 非 null 需立即返回给客户端; true → 继续走 apply/prewarm */
  proceed: boolean;
  /** 立即返回给客户端的响应 (intercept / default-gate); proceed=true 时为 null */
  response: Response | null;
  /** state-machine 或 recover 后的完整 initResult (proceed=false 时可能为 null) */
  initResult: SessionInitResult | null;
  /** 本 turn 是否真的走了 handleSessionInit state machine (recover 分支为 false) */
  wentThroughStateMachine: boolean;
}

/**
 * 主编排。
 *
 * 与老 handler 100% 等价, 差别只在:
 *   - 4 个 callback 参数取代 4 处 inline protocol/agent 特化代码
 *   - metadataClient / store 由本 stage 自己 import (老 runner 里 dynamic import 4 处 duplicate)
 *
 * 老 handler 里的 try/catch degrade (recover/state machine 失败) 保留在 caller 手里,
 * 因为 caller 通常会在 catch 里 log + inject continue 而不是 stage 决定。所以本
 * stage 里的 store 调用不做 try/catch, 让异常向上冒。
 */
export async function stageSessionInitOrchestrate(
  input: SessionInitOrchestrateInput,
): Promise<SessionInitOrchestrateResult> {
  const { getSessionStore, handleSessionInit, parsePresetIdentity } = await import(
    "../../session/index.js"
  );
  const { getMetadataClient } = await import("../../meta/client.js");

  const store = getSessionStore();
  const metadataClient: MetadataClient = getMetadataClient(
    input.config.coreSkill,
    input.spaceId ?? "",
    input.kernelUserKey,
  );
  const presetIdentity: PresetIdentity = parsePresetIdentity(input.config.sessionInit, input.headers) ?? {};

  const compositeKey = input.compositeKeyOverride ?? `${input.agentSourceForState}:${input.sessionKey}`;
  const identity = {
    userId: input.userId || "anonymous",
    agentSource: input.agentSourceForState,
    sessionId: input.sessionKey,
    spaceId: input.spaceId,
  };

  const recovered = await store.getOrRecover(compositeKey, identity, {
    metadataClient,
    messages: input.recoveryMessages,
    presetIdentity,
  });

  const isTerminalState = recovered?.status === "initialized";
  const needsPrewarm =
    recovered?.__recoverySource === "l2b" ||
    recovered?.__recoverySource === "history-scan";

  let initResult: SessionInitResult;
  let wentThroughStateMachine = false;

  // fork passthrough (anthropic 独有): 若 hook 返回非 null, 直接用它作为 initResult
  const forkOverride = input.forkPassthroughHook?.(recovered ?? undefined);
  if (forkOverride) {
    return {
      proceed: true,
      response: null,
      initResult: forkOverride,
      wentThroughStateMachine: false,
    };
  }

  if (recovered && isTerminalState) {
    // Recover branch — protocol-specific rebuild via callback
    const applied = await input.buildRecoverInitResult(recovered, input.recoveryMessages);
    initResult = {
      intercepted: false,
      sessionInfo: recovered.sessionInfo,
      agentDetail: recovered.agentDetail,
      taskDetail: recovered.taskDetail,
      bypassed: recovered.bypassed,
      justRegistered: needsPrewarm,
      ...applied,
    } as SessionInitResult;
  } else {
    wentThroughStateMachine = true;
    const synthesizedMessages = input.synthesizeMessages();
    initResult = await handleSessionInit(
      input.sessionKey,
      input.userId,
      synthesizedMessages,
      input.config.sessionInit,
      store,
      input.buildReqCtx(),
      input.agentSourceForState,
      metadataClient,
      input.kernelUserKey,
      input.spaceId,
      presetIdentity,
    );
  }

  // Intercept branch (form / reset confirmation)
  if (initResult.intercepted) {
    const response = input.buildInterceptResponse(initResult);
    if (response) return { proceed: false, response, initResult, wentThroughStateMachine };
    // Defensive: intercept without response → fall through (should not happen)
  }

  // Default-gate branch (codex/wb only)
  if (input.buildDefaultGateResponse) {
    const gateResponse = input.buildDefaultGateResponse(initResult);
    if (gateResponse) return { proceed: false, response: gateResponse, initResult, wentThroughStateMachine };
  }

  return { proceed: true, response: null, initResult, wentThroughStateMachine };
}
