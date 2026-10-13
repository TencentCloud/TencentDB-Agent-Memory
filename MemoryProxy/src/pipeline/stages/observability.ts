

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { countHumanTurns, resolveMonotonicTurnSeq } from "../../turnSeq.js";
import {
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import { type ForwardTarget } from '../../upstream-target.js';

export interface LangfuseTurnContextBuildInput {
  config: ProxyConfig;
  sessionKey: string;
  keyId: string;
  target: ForwardTarget;
  messages: unknown[];
  /**
   * 协议 — 影响 countHumanTurns 分支。
   * "responses" 走独立的 countHumanTurnsCodex/Workbuddy (codex/wb handler 内部),
   * caller 必须通过 `localTurnSeqOverride` 传入; 不能在此 stage 内自动推导。
   */
  protocol: "openai" | "anthropic" | "responses";
  /** trace 级 tags (稳定维度: protocol/stream/session, 不含 route tag) */
  traceTags: string[];

  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** codex/wb 从各自的 countHumanTurnsXxx 拿到, 若未提供则 stage 用 countHumanTurns(messages, protocol) */
  localTurnSeqOverride?: number;
  /**
   * turnSeq lane (Redis 单调计数分车道)。
   * - handler.ts:1483 不传 → 默认 "main"
   * - anthropicHandler.ts:1409 传 requestKind → main/fork/sidequery 独立车道
   *   保证 CC fork/sidequery 类别不与主对话争 turnSeq。
   */
  lane?: string;

  userQueryOverride?: string | null;
}

export interface LangfuseTurnBundle {
  turnSeq: number;
  lf: LangfuseTurnContext;
}

/**
 * 构造 turn 级 Langfuse 上下文 + 会话级单调 turnSeq。
 *
 * 顺序敏感 (blueprint §5.3):
 *   - resolveMonotonicTurnSeq 需依赖 target.turnSeq 或 stateless 计数
 *   - langfuseTurnTraceId 是纯函数, 依赖上一步的 turnSeq
 */
export async function stageBuildLangfuseTurnContext(
  input: LangfuseTurnContextBuildInput,
): Promise<LangfuseTurnBundle> {
  let localTurnSeq: number;
  if (input.localTurnSeqOverride !== undefined) {
    localTurnSeq = input.localTurnSeqOverride;
  } else if (input.target.turnSeq > 0) {
    localTurnSeq = input.target.turnSeq;
  } else if (input.protocol === "responses") {
    // codex/wb 必须显式传 localTurnSeqOverride (走各自的 countHumanTurnsCodex/Workbuddy);
    // 未传就当 0, 后续 resolveMonotonicTurnSeq 也短路 (localTurnSeq<=0 直返)。
    localTurnSeq = 0;
  } else {
    localTurnSeq = countHumanTurns(input.messages, input.protocol);
  }

  const turnSeq = await resolveMonotonicTurnSeq(
    input.config,
    input.sessionKey,
    localTurnSeq,
    input.lane,
  );

  const lf: LangfuseTurnContext = {
    traceId: langfuseTurnTraceId(input.sessionKey, turnSeq),
    turnSeq,
    traceName: `${input.target.model} / ${input.keyId}`,
    userId: input.keyId,
    sessionId: input.sessionKey,
    tags: input.traceTags,
    routeTags: input.target.tags,
    userQuery: input.userQueryOverride ?? "",
  };

  return { turnSeq, lf };
}


/**
 * 把 lowercase 请求头装成 plain object — handler 里各处都要
 * "for (const [k,v] of c.req.raw.headers.entries()) hdrs[k.toLowerCase()] = v"。
 * 抽出来一份。
 */
export function collectLowerCaseHeaders(c: Context): Record<string, string> {
  const hdrs: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    hdrs[k.toLowerCase()] = v;
  }
  return hdrs;
}
