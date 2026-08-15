/**
 * handler-glue.ts — bridges the per-turn lifecycle in handler.ts /
 * anthropicHandler.ts to core `/v3/skill/conversation/add`.
 *
 * proxy 只走**新链路**: 每次真人对话 round 结束 (agent 给出无 tool_use 的
 * 最终回复) 时, 把本 round 的 conversation 切片 push 给 core, core 累积
 * 到阈值时自己决定何时归档 (进 skill 抽取管线)。
 *
 * 历史: 曾经存在老链路 SkillExtractTrigger → /v3/skill/extract, 由 proxy
 * 每 turn 触发一次抽取, 依赖 proxy 侧 KvExtractStore 存 buffer。已删除,
 * 详见 commit 历史。agent 主动通过 skill-bridge 触发抽取的入口 (/v3/skill/extract)
 * 也一起注释掉了 —— core 侧规划中会出一个"手动归档"接口, 到时候 agent 工具
 * 会重新指向那个接口。
 *
 * 触发时机: **round-level** —— 只有 agent 给出最终回复（无 tool_use /
 * tool_calls）时才 push 到 core。中间态（agent 在调工具，客户端还会带
 * tool_result 回来继续这一轮）直接跳过，等 round 真正结束再一起发。
 *
 * 为什么不是 turn-level (每次 HTTP 都发):
 *   proxy 视角一次 HTTP 是一"turn"，但 Claude Code / CodeBuddy 一次真人
 *   提问会引发 N 次 HTTP (tool-use 循环)。如果每 turn 都发, core buffer
 *   累计极快 —— 默认 10 个 tool_use 就触发一次归档, 生产环境几轮对话
 *   就能打出 30+ 归档。round-level 触发保证 "1 次真人问答 = 1 次 add",
 *   语义清晰, RPC 数下降 ~N 倍。详见
 *   docs/design/2026-07-17-conversation-normalize.md。
 */

import type { ProxyConfig } from "../types.js";
import type { AssetCapabilityFlags } from "../injection/types.js";
import { getCoreSkillClient } from "./core-client.js";
import {
  countToolCalls,
  findLastFinalAssistant,
  isFinalAnswer,
  normalizeConversation,
} from "./normalize-conversation.js";

/** loose message shape 供本模块内部用 */
interface IncomingMsg {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
}

export interface TriggerInput {
  config: ProxyConfig;
  sessionKey: string;
  /** Client type (URL path 第一段)，用于三段隔离键；缺省 `claude-code`。 */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  inputMessages: unknown[] | undefined;
  assistantMessage: Record<string, unknown> | null | undefined;
  /**
   * 请求走的协议 —— 决定 messages/assistantMessage 的解析规则。
   *   "anthropic" → anthropicHandler.ts (/v1/messages), content 可能是 blocks 数组,
   *                 tool_result 藏在 role=user 里, tool_use 藏在 role=assistant 里
   *   "openai"    → handler.ts (/v1/chat/completions), content 一般是字符串,
   *                 tool_result 是独立 role=tool 消息, tool_calls 是 assistant 独立字段
   *   "responses" → codexHandler.ts (/responses), 顶层是 input[] 而非 messages[],
   *                 item 按 type 判别: message / function_call / function_call_output /
   *                 reasoning (详见 normalize-conversation.ts 顶部)
   *
   * proxy 已经通过路由 whitelist 明确知道每条请求走哪个协议（见 routes/whitelist.ts）,
   * 所以由调用方 (handler.ts / anthropicHandler.ts / codexHandler.ts) 显式传入, 不做推断。
   */
  protocol: "anthropic" | "openai" | "responses";
  /** Per-user asset capability flags; skill=false disables extraction collection. */
  assetCapabilities?: AssetCapabilityFlags;
  /** Optional override (e.g. SSE accumulators contain the truth in streaming mode). */
  toolCallCountOverride?: number;
}

export async function triggerSkillExtractIfReady(input: TriggerInput): Promise<void> {
  try {
    const { config, sessionKey, sessionInfo, inputMessages, assistantMessage } = input;
    if (input.assetCapabilities?.skill === false) return;
    if (!sessionKey || !sessionInfo) return;

    const userId = sessionInfo.user_id as string | undefined;
    const teamId = sessionInfo.team_id as string | undefined;
    const agentId = sessionInfo.agent_id as string | undefined;
    if (!userId || !teamId || !agentId) return;

    if (!config.coreSkill?.endpoint || !config.coreSkill?.serviceToken) return;

    const spaceId = sessionInfo.space_id as string | undefined;
    if (!spaceId) {
      console.warn(
        `[skill-conversation-add] skipped: no space_id on sessionInfo session=${sessionKey}`,
      );
      return;
    }

    const msgs: IncomingMsg[] = Array.isArray(inputMessages)
      ? (inputMessages as IncomingMsg[])
      : [];
    const rawAsst = (assistantMessage as Record<string, unknown>) ?? {};
    const hasAsst = Boolean(rawAsst && (rawAsst.role || rawAsst.content || rawAsst.tool_calls));
    const rawMsgs = msgs as unknown[] as Array<Record<string, unknown>>;

    // ── round-level 触发 gate ──
    // 只有 final answer 才继续；含 tool_use / tool_calls 的中间态直接返回。
    // 判定依赖 assistantMessage 里 tool_use / tool_calls 数量;
    // stream 分支 assistantMessage.content 被拉平成 string 丢了 blocks 信息,
    // 此时 input.toolCallCountOverride 才是权威 (见 anthropicHandler.ts:1592-1597).
    if (!isFinalAnswer(hasAsst ? rawAsst : null, input.toolCallCountOverride)) return;

    // ── 本 round 切片 ──
    // slice 起点 = 上一次 "final assistant" 之后 = 本 round 的 user 输入起点。
    // 找不到 (首轮 / 历史全是中间态) → -1 + 1 = 0, 天然发整段, 语义正确。
    const lastFinal = findLastFinalAssistant(rawMsgs, input.protocol);
    const startIdx = lastFinal + 1;

    // 按协议分支做 5-role 规范化 —— 展开 anthropic content blocks / openai tool_calls,
    // 识别 tool_use / tool_result 分别转成 role=tool_call / role=tool_result。
    // agentSource 用于按客户端规则提取 user text (详见 agent-adapters/)
    // 详见 normalize-conversation.ts 和 docs/design/2026-07-17-conversation-normalize.md
    const turnMessages = normalizeConversation(
      rawMsgs.slice(startIdx),
      input.protocol,
      hasAsst ? rawAsst : null,
      input.agentSource,
    );
    if (turnMessages.length === 0) return;

    try {
      const client = getCoreSkillClient(config.coreSkill);
      const t0 = Date.now();
      const result = await client.addConversation(
        {
          session_id: sessionKey,
          space_id: spaceId,
          user_id: userId,
          team_id: teamId,
          agent_id: agentId,
          task_id: sessionInfo.task_id as string | undefined,
          messages: turnMessages,
        },
        // core Shark 走 x-tdai-service-id = 真实内核实例 ID
        { serviceId: spaceId },
      );
      if (result.status === "archived" && result.archived) {
        console.log(
          `[skill-conversation-add] archived session=${sessionKey} task_id=${result.archived.task_id}` +
            ` reason=${result.archived.reason} took=${Date.now() - t0}ms` +
            ` round_msgs=${turnMessages.length} slice=${startIdx}/${rawMsgs.length}`,
        );
      } else {
        // status=ok: 未触发归档 —— core 已把本 round 累计到 buffer, 等下次
        // 或再几次 round 累够阈值才会归档。
        console.log(
          `[skill-conversation-add] appended session=${sessionKey}` +
            ` round_msgs=${turnMessages.length} slice=${startIdx}/${rawMsgs.length}` +
            ` took=${Date.now() - t0}ms`,
        );
      }
    } catch (err) {
      // core 返回失败不影响主响应链; 观察指标看看再决定升级为 error
      console.warn(
        "[skill-conversation-add] addConversation failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  } catch (err) {
    // 保守：任何异常都吞掉，避免影响主响应链。
    console.warn(
      "[skill-extract-glue] triggerSkillExtractIfReady swallowed error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// 兼容: 部分老代码从 handler-glue 里 import countToolCalls
export { countToolCalls };
