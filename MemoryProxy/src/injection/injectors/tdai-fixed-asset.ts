/**
 * Shared helper for chat_memory injectors:
 * resolves (team, user, agent, name) ctx for self + imported ≤2 agents,
 * cached in ctx.metadata.custom for reuse across injectors.
 *
 * Now uses MetadataClient (kernel /v3/meta/agent-fixed-asset/list-with-detail)
 * instead of TMC's proxy endpoint.
 */

import type { AgentContext } from "../types.js";
import type { TdaiIdentity } from "../../tdai/types.js";
import type { MetadataClient } from "../../meta/client.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface FixedAssetCtx {
  teamId: string;
  userId: string;
  agentId: string;
  agentName: string;
  isSelf: boolean;
}

const CACHE_KEY = "__tdaiFixedAssetCtxs";

function parseChatMemoryAssetId(assetId: string): { teamId: string; agentId: string } | null {
  if (!assetId.startsWith("chat_memory-")) return null;
  const marker = "-agt";
  const idx = assetId.lastIndexOf(marker);
  if (idx < 0) return null;
  const inner = assetId.slice("chat_memory-".length);
  const dashAgt = inner.lastIndexOf(marker);
  if (dashAgt < 0) return null;
  return {
    teamId: inner.slice(0, dashAgt),
    agentId: inner.slice(dashAgt + 1),
  };
}

// ── Resolver ───────────────────────────────────────────────────────────────────

/**
 * Get [self, ...imported] ctx. Within a single request, repeat calls hit the
 * ctx cache and do NOT re-call the kernel.
 *
 * Fails gracefully: if kernel is unreachable or the agent has no fixed assets,
 * returns a single entry representing `identity` itself.
 */
export async function resolveFixedAssetCtxs(
  ctx: AgentContext,
  identity: TdaiIdentity,
  client: MetadataClient | null,
  /** 显式读共享授权（评审意见 2）：并入「可访问命名空间集 = 自己 ∪ grants」。 */
  grantsProvider?: (() => Promise<Array<{ teamId: string; agentId: string }>>) | null,
): Promise<FixedAssetCtx[]> {
  const custom = (ctx.metadata.custom ?? {}) as Record<string, unknown>;
  const cached = custom[CACHE_KEY] as FixedAssetCtx[] | undefined;
  if (Array.isArray(cached) && cached.length > 0) return cached;

  const selfCtx: FixedAssetCtx = {
    teamId: identity.teamId,
    userId: identity.userId,
    agentId: identity.agentId,
    agentName: identity.agentId,
    isSelf: true,
  };

  if (!client) {
    const list = [selfCtx];
    custom[CACHE_KEY] = list;
    ctx.metadata.custom = custom;
    return list;
  }

  let result: FixedAssetCtx[] = [selfCtx];
  try {
    const detail = await client.getAgentFixedAssets(identity.agentId);
    const selfAgent = detail.agent as { agent_id?: string; team_id?: string; owner_user_id?: string };
    const selfTeamId = selfAgent?.team_id || identity.teamId;

    const items: FixedAssetCtx[] = [];
    for (const item of detail.items) {
      if (item.asset_type !== "chat_memory") continue;
      const parsed = parseChatMemoryAssetId(item.asset_id);
      if (!parsed) continue;
      if (parsed.teamId !== selfTeamId) continue;
      if (parsed.agentId === (selfAgent?.agent_id ?? identity.agentId)) continue;

      try {
        const sourceAgent = await client.getAgent(parsed.agentId);
        if (sourceAgent.team_id !== selfTeamId) continue;
        items.push({
          teamId: sourceAgent.team_id,
          userId: sourceAgent.owner_user_id ?? identity.userId,
          agentId: sourceAgent.agent_id,
          agentName: sourceAgent.name || item.name || sourceAgent.agent_id,
          isSelf: false,
        });
      } catch {
        // 绑定的来源 agent 已删除/不可见时跳过，避免用 chat_memory asset_id 当 agent_id 查询导致空召回。
      }
    }

    if (items.length > 0) {
      // Prepend self (skip the temporary selfCtx)
      result = [
        {
          teamId: selfTeamId,
          userId: selfAgent?.owner_user_id ?? identity.userId,
          agentId: selfAgent?.agent_id ?? identity.agentId,
          agentName: (selfAgent as any)?.name ?? identity.agentId,
          isSelf: true,
        },
        ...items.slice(0, 2), // max 2 imported
      ];
    }
  } catch (err) {
    // Silently degrade: inject only self
    console.warn("[fixed-asset] kernel error, injecting only self:", (err as Error).message);
  }

  // ── 显式 grant 并入（读共享）：grant 指定的 agent 可读，优先于借入上限 ──
  const grants = grantsProvider ? await grantsProvider() : null;
  if (grants && grants.length > 0) {
    const existingIds = new Set(result.map((c) => c.agentId));
    for (const g of grants) {
      if (!g.teamId || !g.agentId) continue;
      if (g.agentId === (result[0]?.agentId ?? identity.agentId)) continue;
      if (existingIds.has(g.agentId)) continue;
      result.push({
        teamId: g.teamId,
        userId: identity.userId,
        agentId: g.agentId,
        agentName: g.agentId,
        isSelf: false,
      });
      existingIds.add(g.agentId);
    }
  }

  custom[CACHE_KEY] = result;
  ctx.metadata.custom = custom;
  return result;
}
