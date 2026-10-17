/**
 * SkillCandidateProvider —— 取「原本要注入到 prompt 的 skill 候选」。
 *
 * 存在动机
 * ────────
 * proxy 侧 skill 选择链路（`skillRuntime.selection.enabled === true`）需要的是**结构化候选**
 * （skill_id / version / name / description），而不是渲染好的
 * `<available_skills>` 文本块。
 *
 * 召回路径（两条，由 `conversationQuery` 是否非空分流）
 *   A. 有对话 query（selection 优化路径）→ 走 `/v3/skill/search`（mode=hybrid = BM25 + 向量），
 *      作用域与 legacy 主模型 curl 的 skill/search 一致（更宽的 whitelist）。
 *      目的：让领域专项 skill 靠**语义相似度**拿分，而不是被通用 skill 的词面覆盖碾压
 *      （纯 BM25 下 "fix the bug / run tests" 这类框架语会把通用 workflow skill 顶上来）。
 *   B. 无对话 query（legacy 对齐路径）→ 走 `/v3/skill/listing`，行为与
 *      `skill-injector.ts` 的 `prewarm()` 一字不差：
 *        - task_id === defaultTaskId → `mode='activity'`（活跃度召回）
 *        - 否则用 agent/task 描述拼 query 走 BM25；信号不足 → `mode=full`（list head）
 *      只是不渲染、不包 prompt。rollback 时把 `useConversationQuery` 关掉即回到这条路。
 *
 * 缓存
 * ────
 * 缓存的是**候选数据**，不是 `ContextBlock` —— 绝不能借用 hook 的
 * `session_init` 缓存，否则 pipeline 会把它当成待注入内容直接送进 prompt。
 * 这里用进程内 LRU + TTL，多节点各自持有（候选本身是幂等可重算的）。
 *
 * 降级
 * ────
 * 任何失败（core 不可达、老内核不返回 `candidates`、候选为空）一律返回 `[]`，
 * 由调用方决定「不注入 skill」。**不回退**到 legacy 的目录+工具 prompt。
 */

import {
  CoreSkillClient,
  getCoreSkillClient,
  type ListingCandidate,
} from "./core-client.js";
import type { CoreSkillConfig } from "../types.js";
import type { AgentDetail, TaskDetail } from "../session/types.js";

const TAG = "[skill-candidates]";

/** 候选集 TTL —— 与 session 生命周期同量级，超时后重算。 */
const CACHE_TTL_MS = 30 * 60 * 1000;
/** 进程内缓存条目上限，防内存无界增长。 */
const CACHE_MAX_ENTRIES = 2000;

export interface CandidateScope {
  team_id: string;
  agent_id: string;
  space_id?: string;
}

export interface CandidateSet {
  candidates: ListingCandidate[];
  /** core 实际使用的召回模式，用于观测 activity/search/full 分布。 */
  mode: "full" | "search" | "activity";
  /**
   * 候选集指纹 —— 进 decision cache key，候选变了（skill 新增/更新/权限变化）
   * 决策自然失效，不会拿旧选择配新候选。
   */
  fingerprint: string;
}

interface CacheEntry {
  value: CandidateSet;
  expiresAt: number;
}

/**
 * 复刻 `skill-injector.ts:buildListingQuery` 的弱信号判定。
 *
 * 为什么是物理复制而不是 import：两条链路必须能独立演进（legacy 模式的
 * 目录召回不应该被 selection 实验改动影响）。改这里时同步检查那边。
 */
function buildListingQuery(
  agentDetail: AgentDetail | null,
  taskDetail: TaskDetail | null,
): string | undefined {
  const parts: string[] = [];
  if (agentDetail?.description?.trim()) parts.push(agentDetail.description.trim());
  if (agentDetail?.prompt?.trim()) parts.push(agentDetail.prompt.trim());
  if (taskDetail?.description?.trim()) parts.push(taskDetail.description.trim());
  if (taskDetail?.goal?.trim()) parts.push(taskDetail.goal.trim());

  const combined = parts.join(" ").trim();
  if (!combined) return undefined;

  const tokens = new Set(
    combined
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3),
  );
  if (tokens.size < 3) return undefined;

  return combined;
}

function fingerprintOf(candidates: ListingCandidate[]): string {
  // skill_id + version 足够表达「候选集是否变了」；name/description 变化
  // 必然伴随 version 递增（core 侧 head 版本语义）。
  return candidates.map((c) => `${c.skill_id}@${c.version}`).join(",");
}

export class SkillCandidateProvider {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly coreSkill: CoreSkillConfig,
    /** 虚拟 default task id；未配置 → 永不走 activity 分支。 */
    private readonly defaultTaskId?: string,
    /** 测试注入。 */
    private readonly clientOverride?: CoreSkillClient,
  ) {}

  /**
   * 取候选集。命中缓存直接返回；否则调 core listing 重算。
   *
   * @param maxCandidates 参与后续判断的候选上限（截断发生在**排序后**，
   *   core 已按相关性/活跃度排好序，这里只做尾部截断）。
   */
  async get(args: {
    scope: CandidateScope;
    agentDetail: AgentDetail | null;
    taskDetail: TaskDetail | null;
    taskId?: string;
    /**
     * session 级隔离 token（sessionKey / session_id）—— 决定候选缓存的作用域。
     * 由调用方传入，缺省时退回到 team+agent 级共享（历史行为）。
     */
    sessionScope?: string;
    /**
     * 当前对话派生的检索 query（问题陈述 + 近期焦点）。非空时**优先于** activity /
     * agent-task-描述 / list-head：直接用它走 BM25 `search`，把候选缩到与本轮问题
     * 相关的 skill。这是 selection 优化路径的核心 —— 让领域专项 skill 能进候选集，
     * 而不是永远只看到泛化的 list-head 头部。
     *
     * 为什么优先于 activity：e2e/debugForceIdentity 下 task_id 恒为 default，
     * 会一直落 activity（活跃度召回，与"这道题是什么"无关）；有了对话 query 就该
     * 用问题文本检索。空/未传时回到历史行为。
     */
    conversationQuery?: string;
    maxCandidates: number;
  }): Promise<CandidateSet> {
    const { scope, agentDetail, taskDetail, taskId, sessionScope, conversationQuery, maxCandidates } = args;
    const empty: CandidateSet = { candidates: [], mode: "full", fingerprint: "" };

    if (!scope.team_id || !scope.agent_id) return empty;

    const convQuery = conversationQuery?.trim() || undefined;
    const recallByConversation = !!convQuery;
    const isDefaultTask = !recallByConversation
      && !!(this.defaultTaskId && taskId && taskId === this.defaultTaskId);
    // 检索 query 与 mode 的最终决策：
    //   - 有对话 query → 用它，mode=auto（query 非空 → 插件走 BM25 search）
    //   - default-task → activity（活跃度召回）
    //   - 否则 → agent/task 描述拼的弱 query，mode=auto（query 空则 list-head）
    const query = recallByConversation
      ? convQuery
      : (isDefaultTask ? undefined : buildListingQuery(agentDetail, taskDetail));
    const listingMode: "auto" | "activity" | undefined = recallByConversation
      ? undefined
      : (isDefaultTask ? "activity" : undefined);
    const modeTag = recallByConversation ? "conv" : (isDefaultTask ? "activity" : "auto");

    const cacheKey = [
      scope.space_id ?? "_default",
      scope.team_id,
      scope.agent_id,
      // session 作用域 —— 候选缓存必须按当前 session 隔离。
      // 否则同一 team+agent 下不同 session 会共用同一份缓存（本类是进程内
      // LRU + 30min TTL，key 里原本不含 session 身份）：
      //   1) 新建 skill 在 TTL 内不会成为候选；
      //   2) 期间被删/归档的候选仍会被选中，后续 getSkill 失败（core_error）；
      //   3) 一个 session 的候选会“串味”到同 agent 的另一个 session。
      // 为什么用 session 而不是 task：debugForceIdentity / 单 task 多 session 场景下
      // task_id 可能整段固定（如 e2e 评测 10 题共用一个 task_id），按 task 隔离等于没隔离；
      // session 是真正随上下文变化、且与 pinKey 一致的粒度。
      // 加上 sessionScope 后：候选在同一 session 内仍命中缓存（每 session 仅重列一次，
      // 成本与 session_init prewarm 同量级），换 session 即重算，
      // 始终反映该 session 起始时刻的真实 skill 池。
      sessionScope ?? "",
      modeTag,
      // query 参与 key —— 对话 query 逐轮变化时会自然触发重新检索（逐轮语义召回）。
      query ?? "",
      String(maxCandidates),
    ].join("|");

    const now = Date.now();
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > now) return hit.value;

    let value = empty;
    try {
      const client = this.clientOverride ?? getCoreSkillClient(this.coreSkill);

      let rawCandidates: ListingCandidate[];
      let effectiveMode: CandidateSet["mode"];

      if (recallByConversation) {
        // 路径 A：对话语义检索 —— /v3/skill/search（hybrid = BM25 + 向量）。
        // top_k 对齐 maxCandidates（core schema 上限 50）；不传 user_id（read 路径
        // 不按 caller 过滤，否则会毙掉同 team/agent 共享的 skill，见 core-client.ts）。
        const result = await client.searchSkills(
          {
            team_id: scope.team_id,
            agent_id: scope.agent_id,
            query: convQuery!,
            top_k: Math.min(50, Math.max(1, maxCandidates)),
            mode: "hybrid",
          },
          { serviceId: scope.space_id || undefined },
        );
        rawCandidates = (Array.isArray(result.items) ? result.items : [])
          .filter((h) => h && typeof h.skill_id === "string" && typeof h.version === "number")
          .map((h) => ({
            skill_id: h.skill_id,
            version: h.version,
            name: h.name,
            description: h.description,
          }));
        effectiveMode = "search";
      } else {
        // 路径 B：listing（activity / BM25 / list-head）—— 与 legacy prewarm 一致。
        const result = await client.listListing(
          {
            team_id: scope.team_id,
            agent_id: scope.agent_id,
            query,
            mode: listingMode,
          },
          { serviceId: scope.space_id || undefined },
        );
        // 老内核不返回 candidates → 视为无候选。不去解析 `listing` 文本还原
        // 候选（格式受 SKILL_VIEW_MODE / 截断影响，解析不可靠）。
        rawCandidates = (Array.isArray(result.candidates) ? result.candidates : [])
          .filter((c) => c && typeof c.skill_id === "string" && typeof c.version === "number");
        effectiveMode = result.mode;
      }

      if (rawCandidates.length === 0) {
        console.warn(
          `${TAG} no structured candidates (recall=${modeTag}, mode=${effectiveMode})`
            + ` — kernel may predate the \`candidates\` field or query matched nothing;`
            + ` skipping skill injection`,
        );
      }
      const candidates = rawCandidates.slice(0, Math.max(0, maxCandidates));

      value = {
        candidates,
        mode: effectiveMode,
        fingerprint: fingerprintOf(candidates),
      };
      console.log(
        `${TAG} team=${scope.team_id} agent=${scope.agent_id} recall=${modeTag} mode=${effectiveMode}`
          + ` candidates=${candidates.length}`
          + ` query=${(recallByConversation ? convQuery : query) ? "yes" : "no"}`,
      );
    } catch (err) {
      console.warn(`${TAG} core candidate recall failed: ${(err as Error).message}`);
      return empty;
    }

    this.put(cacheKey, value, now);
    return value;
  }

  private put(key: string, value: CandidateSet, now: number): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Map 迭代顺序 = 插入顺序，删最旧一条即可（近似 FIFO，够用）。
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  }

  /** 测试用。 */
  clearCache(): void {
    this.cache.clear();
  }
}
