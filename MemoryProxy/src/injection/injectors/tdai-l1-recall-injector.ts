import type { AgentContext, ContextBlock, ContextMessage, InjectionHook, HookPriority } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getMessageText } from "../context.js";
import type { TdaiClient } from "../../tdai/client.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs } from "./tdai-fixed-asset.js";

/**
 * 取「最后一条真正含人类文本的 user 消息」作为检索词。
 *
 * 不能只取最后一条 user 消息：dsh 0.2.1 起每步都会追加一条 `role=user` 的
 * 运行时通知（时间读数 / 工作目录变更）。它们被 extractUserQueryText 判为噪声
 * 返回 ""，若这时直接 `return []`，整轮 L1 召回会被静默跳过；若反过来拿通知
 * 原文当检索词，则召回全是垃圾。两种情况都错，正解是继续往前找。
 *
 * @param messages - AgentContext 里的消息序列（按时间正序）
 * @returns 干净的用户提问；整段对话没有任何人类文本时返回 ""
 */
export function lastHumanUserQuery(messages: readonly ContextMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const query = extractUserQueryText(getMessageText(msg)).trim();
    if (query) return query;
  }
  return "";
}

/**
 * L1 召回（"自有 + 借入"跨 agent 合并 top-K）：
 *   1. 从 ctx 拿当前 (team, user, agent) identity（ProxyConfig 走出来的）
 *   2. 调控制面 /fixed-asset-agents 拿 [self, ...借入≤2]
 *   3. 对每个 ctx 并发 /atomic/search (query=最后一条含人类文本的 user 消息)
 *   4. 合并所有命中 → 按 score 降序 → 取前 globalTopK
 *   5. 注入到 user.before，每条标 [from <agent_name>]
 *
 * 控制面不可达时降级：仅查当前 agent 的 L1（与改造前的行为一致）。
 */
export class TdaiL1RecallInjector implements InjectionHook {
  id = "tdai-l1-recall-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY;
  description = "Recall TDAI L1 memories from self + imported agents and prepend them to the current user turn";

  /**
   * @param sessionInitConfig 用来调控制面拿 fixed-asset-agents；如果 null，
   *        injector 退化到"只查当前 agent"模式，保持向后兼容。
   * @param perAgentLimit 每个 agent 各自从 tdai 召回多少条（默认 = client 配置）
   * @param globalTopK 合并后保留多少条（默认 5）
   */
  constructor(
    private client: TdaiClient,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
    private perAgentLimit: number | undefined = undefined,
    private globalTopK = 5,
    /**
     * ACL 校验客户端，通常与 `client` 是同一个 TdaiClient 实例。传入后每个
     * fixed-asset ctx 都会走 acl/check(read) 过滤。为 null 时保留旧行为。
     */
    private aclClient: TdaiClient | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    // 用「干净的真实 user_query」作检索词，而不是整条原始消息 blob
    // （后者含 <user_info>/<additional_data>/<question_answer> 等噪声，
    //  会让 FTS5/向量检索命中率极低甚至 0，导致 L1 召不回）。
    // 倒序跳过纯 harness 通知，避免最后一条 user 消息是通知时整轮零召回。
    const query = lastHumanUserQuery(ctx.messages).slice(0, 2048);
    if (!query) return [];

    // 拿 self + 借入 ≤2 个的 ctx 列表
    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId 来自 session 注册时保存的 URL path 中的 `/proxy/<spaceId>/...`；
    // 用作内核的 `x-tdai-service-id` 头做租户路由。
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // 并发对每个 ctx search L1
    const groups = await Promise.all(
      ctxs.map(async (c) => {
        const items = await this.client.searchL1ForCtx(
          { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName },
          query,
          identity.sessionId,
          identity.taskId,
          this.perAgentLimit,
        );
        return items.map((m) => ({
          ...m,
          fromAgentId: c.agentId,
          fromAgentName: c.agentName,
        }));
      }),
    );
    // 合并所有命中，按 score 降序（缺 score 的排末尾）
    const merged = ([] as Array<(typeof groups)[number][number]>)
      .concat(...groups)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, this.globalTopK);

    if (merged.length === 0) return [];

    const lines: string[] = [
      "<tdai_recalled_l1_memories>",
      "以下是与本轮用户问题相关的 TDAI L1 记忆（自有 + 借入合集，按相关度排序），仅用于辅助回答当前这一轮，不要视为永久系统规则：",
    ];
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      const fromTag =
        m.fromAgentId === identity.agentId
          ? "self"
          : `from ${m.fromAgentName ?? m.fromAgentId}`;
      const score = typeof m.score === "number" ? ` score=${m.score.toFixed(3)}` : "";
      lines.push(`${i + 1}. [${m.type ?? "memory"}] [${fromTag}${score}] ${m.content}`);
    }
    lines.push("</tdai_recalled_l1_memories>");

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          count: merged.length,
          sources: ctxs.map((c) => c.agentId),
        },
      },
    ];
  }
}
