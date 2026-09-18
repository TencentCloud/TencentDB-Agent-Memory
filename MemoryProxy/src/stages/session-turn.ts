/**
 * 会话编排单点（中间路线：公共流水线 + 每协议薄壳）。
 *
 * 4 个 handler 在此之前各自拼 `sessionStage → sessionKey/threadId →
 * buildStoreSessionKey`，同一套不变量（线程后缀、别名、身份字段）散落四处，
 * 曾经因此出现“handler 键与状态机键不一致 / Claude Code 没接 thread”的漂移。
 *
 * 本模块把这一小段收敛为单一入口：
 *   - 运行 sessionStage（按协议适配器解析会话键/线程/身份）；
 *   - 用同一份 buildStoreSessionKey 生成 handler 侧复合键；
 *   - 返回规范化结果，供 4 个薄壳 handler 直接消费。
 *
 * handler 仍保留协议差异（表单渲染/注入/转发/tap），但“会话怎么解析、键怎么
 * 拼”只有这里一个实现。
 */
import type { ReqCtx, SessionAdapter } from "./types.js";
import { sessionStage, DEFAULT_SESSION_ADAPTER } from "./session.js";
import { buildStoreSessionKey } from "../session/store.js";

export interface SessionTurnResult {
  /** 显式/自动生成的会话 ID（可能为 null，见 sessionKey）。 */
  conversationId: string | null;
  /** 最终会话键（显式 ID / auto-* / 协议兜底键）。 */
  sessionKey: string;
  /** x-thread-id（可能为 null）。 */
  threadId: string | null;
  /** handler 侧 store 复合键：agentSource:sessionKey[:threadId]。 */
  compositeKey: string;
  keyId?: string;
  spaceId?: string;
}

export interface PrepareSessionTurnOptions {
  /** sessionStage 兜底键缺失时的最终兜底（各协议原先的 `?? ${keyId}:${traceId}` 等）。 */
  fallbackSessionKey?: (ctx: ReqCtx) => string;
}

/**
 * 执行一个请求的会话解析 + 键构造，并返回 4 个 handler 共用的一致性结果。
 */
export async function prepareSessionTurn(
  ctx: ReqCtx,
  adapter: SessionAdapter = DEFAULT_SESSION_ADAPTER,
  options: PrepareSessionTurnOptions = {},
): Promise<SessionTurnResult> {
  await sessionStage(ctx, adapter);
  const conversationId = ctx.conversationId ?? null;
  const threadId = ctx.threadId ?? null;
  const sessionKey =
    ctx.sessionKey ??
    options.fallbackSessionKey?.(ctx) ??
    // 最后兜底：与 codex/workbuddy 旧行为一致，不产生空键。
    `${ctx.keyIdOverride ?? ctx.apiKey ?? "unknown"}:${ctx.traceId ?? "no-trace"}`;
  const compositeKey = buildStoreSessionKey({
    agentSource: ctx.agentSource,
    sessionKey,
    threadId,
    threadIsolation: ctx.config.sessionInit?.threadIsolation?.enabled === true,
  });
  return {
    conversationId,
    sessionKey,
    threadId,
    compositeKey,
    keyId: ctx.keyId,
    spaceId: ctx.spaceId,
  };
}
