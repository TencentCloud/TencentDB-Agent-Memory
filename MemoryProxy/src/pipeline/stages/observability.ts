/**
 * stages/observability.ts — LangfuseTurnContext 构造 + turnSeq 单调化 (Phase 1)。
 *
 * 提取自 4 处近乎相同的 lf 装配代码:
 *   - handler.ts:1482-1499         (openai protocol, target.tags 是 route 标签)
 *   - anthropicHandler.ts:1408-1425 (anthropic protocol, 同上)
 *   - codexHandler.ts / workbuddyHandler.ts 部分 lf 装配 (缺 turn ctx, 后期 opt-in)
 *
 * turnSeq 单调化 (addendum §4.2, cd898d2e) 依赖 Redis, 未启用 Redis 时
 * localTurnSeq 直接返回 —— 保持等价。
 *
 * 本 stage 只做 3 件事:
 *   1. resolveMonotonicTurnSeq → 得到会话级单调 turnSeq
 *   2. langfuseTurnTraceId(sessionKey, turnSeq) → 确定性 traceId
 *   3. 组装 LangfuseTurnContext bundle
 *
 * 不包含 opikCreateTrace / analyzerTrace / debugMetadata 等各自独立的调用 —
 * 那些 caller 拿到 lf 后自行调, Phase 2 protocol strategy 层进一步统一。
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { countHumanTurns, resolveMonotonicTurnSeq } from "../../turnSeq.js";
import {
  langfuseTurnTraceId,
  type LangfuseTurnContext,
} from "../../langfuse.js";
import { resolveLatestUserQuery, reportAnalyzerTrace, type ForwardTarget } from "../../guard-adapter.js";

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
  /** 供 resolveLatestUserQuery 拿最新用户输入 (path + headers + body) */
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
  /**
   * userQuery 覆写 (58e4c55b opencode fix)。
   * opencode 主请求的最后一条 user content 才是本 turn 用户输入, 且 tool-loop
   * 续接以 tool 消息结尾时不该被算作新 human input; caller 算好传入即可,
   * 不传时 stage 走 resolveLatestUserQuery 默认姿势。
   */
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
    userQuery: input.userQueryOverride ?? resolveLatestUserQuery(
      input.config,
      input.headers,
      input.path,
      input.body,
      input.messages,
    ),
  };

  return { turnSeq, lf };
}

/**
 * analyzerTrace 上报 — target.analyzerTrace 非 null 时调 reportAnalyzerTrace。
 * openai-chat + anthropic runner 内联块合并。
 */
export function stageReportAnalyzerTrace(input: {
  config: ProxyConfig;
  target: ForwardTarget;
  traceId: string;
  lf: LangfuseTurnContext;
  keyId: string;
  sessionKey: string;
  turnSeq: number;
  startTime: string;
  spaceId: string;
}): void {
  if (!input.target.analyzerTrace) return;
  reportAnalyzerTrace(input.config, input.target.analyzerTrace, {
    traceId: input.traceId,
    langfuseTraceId: input.lf.traceId,
    traceName: input.lf.traceName,
    traceTags: input.lf.tags,
    keyId: `${input.keyId}:${input.sessionKey}`,
    sessionKey: input.sessionKey,
    turnSeq: input.turnSeq,
    startTime: input.startTime,
    spaceId: input.spaceId,
  });
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
