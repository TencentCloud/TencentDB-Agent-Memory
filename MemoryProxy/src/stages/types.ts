/**
 * 请求阶段共享的上下文：各阶段通过它传递输入与产出。
 * 先只放会话阶段需要的字段，随阶段增多逐步扩展。
 */
import type { Context } from "hono";
import type { ProxyConfig } from "../types.js";

/** 会话阶段的客户端差异点：不同协议如何取会话 ID、首条用户消息、兜底键。 */
export interface SessionAdapter {
  /** 从请求提取显式会话 ID（无则返回 null）。 */
  extractRawSessionId(
    c: Context,
    lcHeaders: Record<string, string>,
    body: Record<string, unknown>,
  ): string | null;
  /** 首条用户消息来源（chat 用 body.messages，responses 用 body.input）。 */
  userMessages(body: Record<string, unknown>): unknown;
  /** 无显式 ID 且自动生成未命中时的兜底会话键。 */
  fallbackSessionKey(ctx: ReqCtx, keyId: string, lcHeaders: Record<string, string>): string | null;
  /** 显式线程 ID（用于 scope 隔离）。 */
  resolveThreadId(c: Context): string | null;
  /** 无显式会话 ID 时是否自动生成（workbuddy 原行为不生成）。 */
  autoGenerate?: boolean;
  /** 身份解析与 keyId 改写策略（默认：userId 命中则改写 keyId；codex 直通）。 */
  resolveIdentity(
    ctx: ReqCtx,
    keyId: string,
  ): { keyId: string; userId: string; callerUserKey: string | null };
}

export interface ReqCtx {
  c: Context;
  config: ProxyConfig;
  body: Record<string, unknown>;
  agentSource: string;
  apiKey: string;
  /** 调用方已算好的 keyId（如 codex 的 userId||apiKey 派生），阶段不再重算。 */
  keyIdOverride?: string;
  earlySpaceId: string;
  earlyUserId: string;
  traceId?: string;
  /** 联调用：解析出 userId 后强制覆盖（handler.ts 的 debugForceUserId）。 */
  debugForceUserId?: string;
  // 会话阶段产出
  keyId?: string;
  lcHeaders?: Record<string, string>;
  sessionKey?: string | null;
  conversationId?: string | null;
  threadId?: string | null;
  spaceId?: string;
  userId?: string;
  callerUserKey?: string | null;
}
