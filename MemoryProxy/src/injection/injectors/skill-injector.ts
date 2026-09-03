/**
 * Skill Injector — emits the `<available_skills>` block containing skills
 * owned by the current agent (team_id + agent_id filtered via /v3/skill/listing).
 *
 * The sister hook `skill-tools-injector.ts` emits the static `<skill_tools>`
 * block describing the curl recipes. Together:
 *   <skill_tools>        = how to use skills (via /skill-bridge curl)
 *   <available_skills>   = which skills belong to this agent (owner-filtered)
 *
 * The listing endpoint uses routing internally:
 *   - No query → list head (full listing when ≤ searchTopK, search when >)
 *   - Returns a pre-rendered `<available_skills>` text block ready to inject.
 *
 * Strategy:
 *   - cacheStrategy: "session_init" — listing runs once at prewarm time,
 *     the resulting block is reused for all turns in the session.
 *   - Calls core directly via `CoreSkillClient.listListing`.
 *   - Failure / empty listing → 0 blocks (graceful degradation).
 *
 * The LLM can discover team-wide skills via the skill_search tool (separate).
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import {
  CoreSkillClient,
  getCoreSkillClient,
  type ListingResult,
} from "../../skill/core-client.js";
import type { CoreSkillConfig } from "../../types.js";

const TAG = "[skill-injector]";

export interface SkillInjectorConfig {
  /** Core skill client config; passed to `getCoreSkillClient(config)`. */
  coreSkill: CoreSkillConfig;
}

/**
 * Prompt boilerplate wrapping the `<available_skills>` listing.
 *
 * Compact routing policy for the proxy's cloud-skill listing. The exact curl
 * contracts remain in `<skill_tools>`; this wrapper only decides whether to
 * view a listed skill, search for an unlisted specialist workflow, or skip.
 */
const SKILL_LISTING_HEADER = `## Cloud skills
先判断任务是否需要专项工作流：
- 列表中的 skill 与任务/工作流明确匹配：调用 skill_view 后遵循其说明。
- 确实需要专项能力但列表无匹配：调用 skill_search。
- 普通 coding、当前上下文足够或仅词面相似：不要调用 skill。`;

/**
 * Wrap the pre-rendered `<available_skills>` listing from plugin into a
 * context block, with additional instructions about skill-bridge access.
 *
 * Layout (top → bottom, single joined string):
 *   1. Compact routing boundary.
 *   2. Cloud access reminder.
 *   3. `<available_skills>` listing (verbatim from core).
 */
export function wrapAvailableSkillsBlock(listing: string): string {
  return [
    SKILL_LISTING_HEADER,
    "这些 skill 存储在云端，只能通过上方 <skill_tools> 的 Bash + curl 访问。",
    "",
    listing,
  ].join("\n");
}

/**
 * Build a search query for listing from agent/task descriptions.
 * Combines agent prompt + task description + task goal to form a
 * semantically meaningful query for FTS BM25 matching.
 *
 * Returns `undefined` when the combined text has too weak signal to
 * usefully drive BM25 search — in that case core falls back to
 * mode=full and returns the head of the skill list. Weak-signal
 * heuristic: after dedup + lowercasing, fewer than 3 distinct tokens
 * of length ≥ 3. Catches placeholder-named agents like
 * `testagent1` whose description/prompt is literally "testagent1"
 * (would otherwise BM25 to zero hits and inject no skills at all).
 */
function buildListingQuery(input: PrewarmInput): string | undefined {
  const parts: string[] = [];
  const ad = input.agentDetail;
  const td = input.taskDetail;

  if (ad?.description?.trim()) parts.push(ad.description.trim());
  if (ad?.prompt?.trim()) parts.push(ad.prompt.trim());
  if (td?.description?.trim()) parts.push(td.description.trim());
  if (td?.goal?.trim()) parts.push(td.goal.trim());

  const combined = parts.join(" ").trim();
  if (!combined) return undefined;

  // Weak-signal check: split on non-word chars, keep tokens length ≥ 3,
  // dedup case-insensitively. Under 3 distinct tokens → treat as no query
  // so core returns the full head (`mode=full`).
  const tokens = new Set(
    combined
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3),
  );
  if (tokens.size < 3) return undefined;

  return combined;
}

/**
 * Skill injector hook.
 * Targets: system.before_tools injection point (→ before <agent_skills>).
 */
export class SkillInjector implements InjectionHook {
  id = "skill-injector";
  point = "system.before_tools" as const;
  /** Lands before the "skills" region (CodeBuddy: `<agent_skills>`). */
  anchor: AnchorTarget = { slot: "skills", relation: "before" };
  priority: HookPriority = HOOK_PRIORITY.SKILL;
  description = "Inject agent-owned cloud skills via /v3/skill/listing before <agent_skills>.";
  /** Listing result is stable for the session. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(
    private config: SkillInjectorConfig,
    /** Optional override (tests). */
    private clientOverride?: CoreSkillClient,
  ) {}

  /**
   * Live-path execute (cache-miss self-heal).
   *
   * With `cacheStrategy: "session_init"`, the pipeline normally serves the
   * prewarmed block from `HookCacheRepo`. When that cache misses — e.g. this
   * request landed on a different proxy node than the one that ran prewarm,
   * Redis was unavailable, the entry expired, or prewarm never fired — the
   * pipeline (`InjectionPipeline.resolveHookBlocks`) falls back to `execute()`
   * and *re-populates* the cache with whatever we return. So this method must
   * be able to reproduce the same block the prewarm path would have produced.
   *
   * The only degradation vs. prewarm is the search `query`: on the live path
   * we don't have `agentDetail`/`taskDetail`, so core routes to `mode=full`
   * (head of the listing). That is an accepted trade-off, documented in
   * `BUG-skill-injection-multinode.md` §Solution 1.
   *
   * Historically this returned `[]` unconditionally, which meant a miss on
   * any node other than the one that ran prewarm silently dropped
   * `<available_skills>` from the system prompt for the entire session.
   */
  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const caps = custom?.assetCapabilities as { skill?: boolean } | undefined;
    if (caps?.skill === false) return [];
    const session = custom?.session as {
      team_id?: string;
      agent_id?: string;
      space_id?: string;
    } | undefined;
    // No search query on the live path — core will route to mode=full.
    return this.renderListingBlocks({
      team_id: session?.team_id,
      agent_id: session?.agent_id,
      space_id: session?.space_id,
      query: undefined,
      trigger: "execute",
    });
  }

  /**
   * Session-init prewarm: call /v3/skill/listing with team_id + agent_id
   * and a search query built from agent/task descriptions so the returned
   * skills are semantically relevant to the current task (FTS BM25).
   * Inject the pre-rendered `<available_skills>` block verbatim.
   */
  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.skill === false) return [];
    const ids = input.sessionInfo;
    // Build search query from agent description + task description
    // so listing semantically matches relevant skills (FTS BM25).
    const query = buildListingQuery(input);
    return this.renderListingBlocks({
      team_id: ids?.team_id,
      agent_id: ids?.agent_id,
      space_id: ids?.space_id,
      query,
      trigger: "prewarm",
    });
  }

  /**
   * Shared listing → wrapped `<available_skills>` block renderer used by both
   * `prewarm()` and `execute()`. Keeping a single code path guarantees the
   * two entry points emit *identical* blocks (same content + same
   * `metadata.cacheKey`), so the pipeline's self-heal write never fragments
   * the KV cache against the prewarm entry.
   *
   * Contract:
   *   - Missing team_id or agent_id → return [] (nothing to route on).
   *   - Any core error → log + return [] (never fails the request).
   *   - Listing rendered as "(none)" or empty → return [].
   *   - Never throws.
   */
  private async renderListingBlocks(args: {
    team_id?: string;
    agent_id?: string;
    space_id?: string;
    query: string | undefined;
    trigger: "prewarm" | "execute";
  }): Promise<ContextBlock[]> {
    const { team_id, agent_id, space_id, query, trigger } = args;
    if (!team_id || !agent_id) {
      console.log(
        `${TAG} ${trigger}: missing session identity (team_id/agent_id) — skipping listing`,
      );
      return [];
    }

    // Route the request to the correct kernel tenant. `space_id` is the
    // instance ID extracted from `/{agent}/{spaceId}/...` at session-init;
    // when absent CoreSkillClient falls back to `config.coreSkill.serviceId`
    // (older single-tenant deployments).
    const serviceId = space_id || undefined;
    console.log(
      `${TAG} ${trigger} team=${team_id} agent=${agent_id}`
        + ` space=${space_id ?? "(none)"} serviceId=${serviceId ?? "(fallback config)"}`
        + ` query=${JSON.stringify(query?.slice(0, 80) ?? null)}`,
    );

    let result: ListingResult;
    try {
      const client = this.clientOverride ?? getCoreSkillClient(this.config.coreSkill);
      result = await client.listListing({
        team_id,
        agent_id,
        query,
      }, { serviceId });
      console.log(
        `${TAG} ${trigger} result mode=${result.mode}`
          + ` hits=${result.hits?.length ?? 0} listingLen=${(result.listing ?? "").length}`,
      );
    } catch (err) {
      console.warn(
        `${TAG} ${trigger} core listing failed, degrading to empty <available_skills>: ${(err as Error).message}`,
      );
      return [];
    }

    const listing = result.listing;
    if (!listing || listing.includes("(none)")) return [];

    const content = wrapAvailableSkillsBlock(listing);
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        skillCount: result.hits.length,
        mode: result.mode,
        // Shared cache key across prewarm + execute so pipeline self-heal
        // writes replace, not fragment, the prewarmed entry.
        cacheKey: "skill-injector:catalog",
      },
    }];
  }
}
