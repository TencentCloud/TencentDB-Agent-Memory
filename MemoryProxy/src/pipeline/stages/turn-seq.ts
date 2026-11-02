/**
 * stages/turn-seq.ts — 会话级权威 turnSeq 的唯一来源。
 *
 * 背景:
 *   一个 turn = 一次用户输入, 一个 turn = 一条 Langfuse trace。要让该 turn
 *   内的 injection span / mem-command span / LLM generation 挂到同一 trace,
 *   它们必须用同一个权威 turnSeq (`LangfuseInjectionObserver` 和
 *   `langfuseReportGeneration` 都用 `(sessionKey, turnSeq)` 派生 traceId)。
 *
 *   现状问题 (治理前):
 *     - codex/workbuddy: lf 在 runner 入口构造, injection 直接复用 — OK
 *     - CC/openai-chat:  injection stage 用 stateless `countHumanTurns`, lf
 *                        构造走 `resolveMonotonicTurnSeq` (Redis Lua), 开 Redis
 *                        + 客户端历史截断场景下 (turnSeq.ts:19-20 注释提到的
 *                        "97 → 1" compaction) 两值分家 → 本轮 injection span
 *                        挂到幽灵 trace。
 *     - mem-command intercept: CC/openai-chat 没传 langfuseCtx, 走 inline
 *                        countHumanTurns, 同款漂移。
 *
 *   治理方向:
 *     在 runner 入口把权威 turnSeq 一次算清楚(含 Redis Lua), 之后
 *     mem-command / injection / lf 构造 全部复用, 保证一个 turn 的所有
 *     observation 挂到同一条 Langfuse trace。
 *
 * 行为:
 *   = `resolveMonotonicTurnSeq(countHumanTurns(messages, protocol))`
 *   Redis 未开/未命中/Lua 失败/localTurnSeq ≤ 0 时, 原样返回 localTurnSeq
 *   (与现网 fallback 一致, 不新增失败路径)。
 *
 *   lane 参数透传给 Redis Lua, 用途与 `resolveMonotonicTurnSeq` 一致:
 *   把共用 sessionKey、历史长度悬殊的请求流分开计数 (CC main/fork/sidequery
 *   各自独立车道)。openai-chat 默认走 "main"。
 *
 * 为什么单起一个 stage 文件:
 *   `stageBuildLangfuseTurnContext` 内部已有同款逻辑, 但它绑定了 `target`
 *   (traceName 要 target.model)。runner 入口 target 还没解析, 不能在那里
 *   构造完整 lf, 但 **turnSeq 本身**可以提前算 — 这里就是把 turnSeq 的
 *   resolve 环节单独暴露, 不改 stageBuildLangfuseTurnContext 的签名也能复用。
 */

import type { ProxyConfig } from "../../types.js";
import { countHumanTurns, resolveMonotonicTurnSeq } from "../../turnSeq.js";

export interface ResolveTurnSeqInput {
  config: ProxyConfig;
  sessionKey: string;
  /** 用于 countHumanTurns 的消息数组 (anthropic 和 openai 两种 schema)。 */
  messages: unknown[];
  /** countHumanTurns 的协议分支 — anthropic/openai, 不含 responses。
   *  codex/workbuddy 走 countHumanTurnsResponses, 在 runner 里自己算, 本
   *  stage 不覆盖它们那条路径。 */
  protocol: "openai" | "anthropic";
  /** Redis Lua 的分车道标签, 默认 "main"。CC 独有 fork/sidequery 分流时
   *  传 `requestKind`, 其余 runner 保持默认即可。 */
  lane?: string;
  /** 覆写 localTurnSeq (走 responses API 时 caller 用自己的
   *  countHumanTurnsResponses 算; 其他情况留空走内部 countHumanTurns)。 */
  localTurnSeqOverride?: number;
}

/**
 * 返回该 turn 的权威 turnSeq。
 *
 * 调用保证:
 *   - 同一 (sessionKey, lane) 下同一 turn 的多次调用返回相同值 (Redis Lua
 *     markField 复用, 本地也只数一次 countHumanTurns)
 *   - Redis 不可用时 fallback 到纯 countHumanTurns, 不抛错不阻塞请求
 */
export async function stageResolveTurnSeq(
  input: ResolveTurnSeqInput,
): Promise<number> {
  const localTurnSeq = input.localTurnSeqOverride !== undefined
    ? input.localTurnSeqOverride
    : countHumanTurns(input.messages, input.protocol);

  return resolveMonotonicTurnSeq(
    input.config,
    input.sessionKey,
    localTurnSeq,
    input.lane ?? "main",
  );
}
