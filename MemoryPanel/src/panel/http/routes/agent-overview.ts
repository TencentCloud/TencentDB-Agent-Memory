import type { Hono } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import type { MetaCallContext } from "../../kernel/types.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";
import { respondControlError, respondEnvelope } from "../envelope.js";
import {
  ASSET_TYPE_CODE_GRAPH,
  ASSET_TYPE_WIKI,
  buildCtx,
  fetchAllMetaListItems,
  isActiveMetaAsset,
  joinKnowledgeAssetsWithKs,
  okEnvelope,
  readJson,
  requireTeamMember,
  str,
  strArray,
  type KnowledgeAssetMetaRaw,
} from "./knowledge/common.js";

interface MetaAssetRaw {
  asset_id: string;
  asset_type: string;
  name: string;
  description?: string | null;
  team_id: string;
  owner_user_id: string;
  visibility: string;
  status: string;
  created_at: string;
  updated_at: string;
  version?: number;
}

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  status?: string;
  metadata_json?: string;
}

interface SkillSummaryRaw {
  skill_id: string;
  owner_agent_id?: string;
  status?: string;
}

interface FixedAssetTypeCounts {
  skill: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

interface AgentFixedAssetSummary {
  agent_id: string;
  counts: FixedAssetTypeCounts;
  total: number;
}

export interface AgentMountedCounts {
  skills: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

function isActiveStatus(status: string | undefined): boolean {
  return (
    status !== "archived" &&
    status !== "deprecated" &&
    status !== "failed" &&
    status !== "inactive"
  );
}

function toMountable(asset: {
  id: string;
  title: string;
  group: string;
  slug?: string;
  status?: string;
}) {
  return {
    key: asset.id,
    title: asset.title,
    group: asset.group,
    slug: asset.slug ?? asset.id,
    status: asset.status,
  };
}

function emptyFixedCounts(): FixedAssetTypeCounts {
  return { skill: 0, code_graph: 0, llm_wiki: 0, chat_memory: 0 };
}

function ownChatMemoryCount(
  agentId: string,
  selfMemoryAgentIds: Set<string>,
): number {
  return selfMemoryAgentIds.has(agentId) ? 1 : 0;
}

/**
 * 1× summary-by-agents（内核）+ skills 来自 Skill list（语义不变）。
 * 前端 counts 路径依赖此结果；bootstrap.counts 保留兼容。
 */
export async function buildMountedCounts(
  deps: PanelDeps,
  ctx: MetaCallContext,
  agentIds: string[],
  skillCounts: Map<string, number>,
  selfMemoryAgentIds = new Set(agentIds),
): Promise<Record<string, AgentMountedCounts>> {
  const counts: Record<string, AgentMountedCounts> = {};
  for (const agentId of agentIds) {
    counts[agentId] = {
      skills: skillCounts.get(agentId) ?? 0,
      code_graph: 0,
      llm_wiki: 0,
      chat_memory: ownChatMemoryCount(agentId, selfMemoryAgentIds),
    };
  }
  if (agentIds.length === 0) return counts;

  const env = await deps.metaKernel.invoke(
    "agent-fixed-asset/summary-by-agents",
    { agent_ids: agentIds },
    ctx,
  );
  if (env.code !== 0 || !env.data || typeof env.data !== "object")
    return counts;

  const items = Array.isArray((env.data as { items?: unknown }).items)
    ? (env.data as { items: AgentFixedAssetSummary[] }).items
    : [];

  for (const row of items) {
    const fc = row.counts ?? emptyFixedCounts();
    counts[row.agent_id] = {
      skills:
        counts[row.agent_id]?.skills ?? skillCounts.get(row.agent_id) ?? 0,
      code_graph: fc.code_graph ?? 0,
      llm_wiki: fc.llm_wiki ?? 0,
      chat_memory: Math.max(
        fc.chat_memory ?? 0,
        ownChatMemoryCount(row.agent_id, selfMemoryAgentIds),
      ),
    };
  }
  return counts;
}

export function registerAgentOverviewRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post("/agent-overview/bootstrap", mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const teamId = str(body, "team_id");
    if (!teamId) return respondControlError(c, 400, "MISSING_TEAM_ID");
    const gate = await requireTeamMember(deps, c, ctx, teamId);
    if ("error" in gate) return gate.error;

    const requestedAgentIds = strArray(body, "agent_ids");

    const [
      skillAssetsRes,
      codeAssetsRes,
      wikiAssetsRes,
      chatTeamAssetsRes,
      agentsRes,
      skillListRes,
    ] = await Promise.allSettled([
      fetchAllMetaListItems<MetaAssetRaw>(deps, ctx, "asset/list-accessible", {
        user_id: gate.userId,
        team_id: teamId,
        asset_type: "skill",
        action: "read",
        // 与 SkillsPanel "团队资产" tab 保持一致：初始化资产选择器只列
        // team-shared 的 skill，不包含私密（含自己 owner 的私密）。
        visibility: "team",
      }),
      fetchAllMetaListItems<KnowledgeAssetMetaRaw>(
        deps,
        ctx,
        "asset/list-accessible",
        {
          user_id: gate.userId,
          team_id: teamId,
          asset_type: ASSET_TYPE_CODE_GRAPH,
          action: "read",
          visibility: "team",
        },
      ),
      fetchAllMetaListItems<KnowledgeAssetMetaRaw>(
        deps,
        ctx,
        "asset/list-accessible",
        {
          user_id: gate.userId,
          team_id: teamId,
          asset_type: ASSET_TYPE_WIKI,
          action: "read",
          visibility: "team",
        },
      ),
      fetchAllMetaListItems<MetaAssetRaw>(deps, ctx, "asset/list-accessible", {
        user_id: gate.userId,
        team_id: teamId,
        asset_type: "chat_memory",
        action: "read",
        // 不限制 visibility：list-accessible 已经按 caller 的 read 权限过滤
        // （private 只有 owner 能看到自己的、team 全员可见）。这样：
        //   - Owner 能看到自己所有 chat_memory（含 private，用于选自己的记忆挂到别的 agent）
        //   - 其他成员只看到 team 可见的
        //   - 已被 owner 撤回私密的记忆 → 其他成员看不到（list-accessible 会过滤）
        // 之前硬编码 visibility='team' 会误伤"自己 owner 的 private" —— 创建/编辑
        // agent 时看不到自己的记忆池；且外部借入这些私密后即使已解除也会残留在
        // 选择列表里造成困惑。
      }),
      // 分页拉全量：limit 上限 100，团队 agent > 100 时裸 invoke 会截断
      // （新建 Agent 的"挂到哪个 agent"选择器、self memory 判断都会漏）
      fetchAllMetaListItems<AgentRaw>(deps, ctx, "agent/list", { team_id: teamId }),
      // skill 真实归属：skill 内核 list（按 owner_agent_id 统计），运行时注入
      // <available_skills> 读的就是这张表，是权威源。
      deps.skillKernel.invoke(
        "list",
        {
          user_id: gate.userId,
          team_id: teamId,
          filters: { status: ["active"] },
          pagination: { limit: 1000, offset: 0 },
        },
        ctx,
      ),
    ]);

    const skillAssets =
      skillAssetsRes.status === "fulfilled"
        ? skillAssetsRes.value.filter((a) => isActiveStatus(a.status))
        : [];
    const codeMeta =
      codeAssetsRes.status === "fulfilled"
        ? codeAssetsRes.value.filter((a) => isActiveMetaAsset(a.status))
        : [];
    const wikiMeta =
      wikiAssetsRes.status === "fulfilled"
        ? wikiAssetsRes.value.filter((a) => isActiveMetaAsset(a.status))
        : [];
    // chat_memory 资产池 = asset/list visibility='team' 的结果（已限定「已共享」）。
    // 不再按 id 前缀 chat_memory-{team}-* 过滤 self memory —— 该前缀只能判断
    // 「是不是某 agent 的自身记忆」，无法区分「未共享的 self memory」与
    // 「已被用户显式共享到团队的 agent 记忆」。self memory 默认 visibility=private
    // （见本文件下方 memory-block 构造：默认 'private'），根本不会被 visibility='team'
    // 查询命中；只有用户主动共享后才变 team —— 而这正是应允许其它 agent 绑定的场景。
    // 旧的前缀过滤会把这类「已共享的 agent 记忆」一并误杀，导致新建 Agent 时选不到、
    // 绑不上团队共享 memory（与 Chat_Memory 页「团队资产」tab 展示不一致）。
    // 「当前 agent 自己的 self memory 默认绑定、不可解绑」由前端按 selfChatMemoryId 处理，
    // 与团队级资产池无关。
    const chatTeamAssets =
      chatTeamAssetsRes.status === "fulfilled"
        ? chatTeamAssetsRes.value.filter((a) => isActiveStatus(a.status))
        : [];
    const agents =
      agentsRes.status === "fulfilled"
        ? agentsRes.value.filter((a) => isActiveStatus(a.status))
        : [];
    const agentIds =
      requestedAgentIds.length > 0
        ? requestedAgentIds
        : agents.map((a) => a.agent_id);
    const selfMemoryAgentIds = new Set(agents.map((a) => a.agent_id));

    // skillCounts 从 skill 内核 list 按 owner_agent_id 统计（含 fork 副本）。
    // 这是 skill 真实归属源，运行时注入 <available_skills> 读的就是它。
    const skillCounts = new Map<string, number>();
    if (skillListRes.status === "fulfilled" && skillListRes.value.code === 0) {
      const items =
        (skillListRes.value.data as { items?: SkillSummaryRaw[] } | null)
          ?.items ?? [];
      for (const item of items) {
        if (!item.owner_agent_id || item.status === "archived") continue;
        skillCounts.set(
          item.owner_agent_id,
          (skillCounts.get(item.owner_agent_id) ?? 0) + 1,
        );
      }
    }

    const [codeItems, wikiItems, counts] = await Promise.all([
      joinKnowledgeAssetsWithKs(
        deps,
        ctx,
        codeMeta,
        ASSET_TYPE_CODE_GRAPH,
      ).catch(() => []),
      joinKnowledgeAssetsWithKs(deps, ctx, wikiMeta, ASSET_TYPE_WIKI).catch(
        () => [],
      ),
      // counts 全部读真实源：skills 来自 skill 表；code_graph/llm_wiki/chat_memory
      // 来自 agent-fixed-asset 表（summary-by-agents）。不再读 metadata_json.ui。
      buildMountedCounts(
        deps,
        ctx,
        agentIds,
        skillCounts,
        selfMemoryAgentIds,
      ).catch(() => {
        const fallback: Record<string, AgentMountedCounts> = {};
        for (const agentId of agentIds) {
          fallback[agentId] = {
            skills: skillCounts.get(agentId) ?? 0,
            code_graph: 0,
            llm_wiki: 0,
            chat_memory: ownChatMemoryCount(agentId, selfMemoryAgentIds),
          };
        }
        return fallback;
      }),
    ]);

    // assets.chatMemories 只放真正 team-shared 的 chat_memory（chatTeamAssets 已过滤 self memory）。
    // 不再注入 myAgents 的 self memory：前端 AgentEditDialog 会自己注入当前 agent 的 self memory，
    // 后端注入会把"我作为 owner 的其他 agent 的 self memory"也塞进来，污染其他 agent 的资产池。
    const memoryItems = new Map<string, ReturnType<typeof toMountable>>();
    for (const asset of chatTeamAssets) {
      memoryItems.set(
        asset.asset_id,
        toMountable({ id: asset.asset_id, title: asset.name, group: "MEMORY" }),
      );
    }

    return respondEnvelope(
      c,
      okEnvelope(c, {
        assets: {
          skills: skillAssets.map((s) =>
            toMountable({ id: s.asset_id, title: s.name, group: "SKILL" }),
          ),
          codeGraphs: codeItems.map((item) =>
            toMountable({
              id: item.knowledge_id,
              title: item.name || item.repo_url || item.knowledge_id,
              group: "CODE",
              // slug 用 knowledge_id（cg-xxx），与 skill/wiki 统一展示资产 id；
              // 仓库地址已在 title 中体现，无需再用 repo_url 覆盖副标题。
              slug: item.knowledge_id,
              status: item.status,
            }),
          ),
          wikis: wikiItems.map((item) =>
            toMountable({
              id: item.knowledge_id,
              title: item.name,
              group: "WIKI",
              status: item.status,
            }),
          ),
          chatMemories: Array.from(memoryItems.values()),
        },
        /** @deprecated 前端 counts 可继续消费；内部已改用 summary-by-agents，不再 N× list */
        counts,
      }),
    );
  });
}
