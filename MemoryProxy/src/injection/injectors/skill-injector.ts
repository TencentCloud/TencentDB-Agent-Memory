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
 * Mirrored from `MemoryCore/src/core/skill/prompts/skill-listing-prompt.ts`
 * (SKILL_ENGINEERING_DESIGN appendix C.1). Kept as a physical copy — the
 * plugin boundary rules forbid cross-plugin deep imports. Wording is adapted
 * to reference the proxy's skill-bridge tool names (`skill_view`,
 * `skill_patch`) instead of the design-doc's hypothetical `skill_view(name)` /
 * `skill_manage(action='patch')` function calls. Read the `<skill_tools>`
 * block above `<available_skills>` for the exact curl recipes.
 *
 * When updating either copy, update the other so the LLM sees consistent
 * guidance regardless of which host renders the block.
 */
const SKILL_LISTING_HEADER =
  "## Skills (mandatory)\n"
  + "Before replying, scan the skills below. If a skill matches or is even partially relevant "
  + "to your task, you MUST load it by calling the `skill_view` skill-bridge tool "
  + "(see the `<skill_tools>` block above for the exact curl recipe) and follow its instructions. "
  + "Err on the side of loading — it is always better to have context you don't need "
  + "than to miss critical steps, pitfalls, or established workflows. "
  + "Skills contain specialized knowledge — API endpoints, tool-specific commands, "
  + "and proven workflows that outperform general-purpose approaches. Load the skill "
  + "even if you think you could handle the task with basic tools like web_search or terminal. "
  + "Skills also encode the user's preferred approach, conventions, and quality standards "
  + "for tasks like code review, planning, and testing — load them even for tasks you "
  + "already know how to do, because the skill defines how it should be done here.\n"
  + "If a skill has issues, fix it with the `skill_patch` skill-bridge tool.\n"
  + "After difficult/iterative tasks, offer to save the approach as a new skill "
  + "(`skill_create`). If a skill you loaded was missing steps, had wrong commands, "
  + "or needed pitfalls you discovered, update it before finishing.\n";

const SKILL_LISTING_FOOTER =
  "\nOnly proceed without loading a skill if genuinely none are relevant to the task.";

/**
 * Wrap the pre-rendered `<available_skills>` listing from plugin into a
 * context block, with additional instructions about skill-bridge access.
 *
 * Layout (top → bottom, single joined string):
 *   1. SKILL_LISTING_HEADER — English mandatory-load directive (mirrored
 *      from MemoryCore).
 *   2. Chinese fallback + skill-bridge/curl usage reminder.
 *   3. `<available_skills>` listing (verbatim from core).
 *   4. SKILL_LISTING_FOOTER — "only skip if genuinely nothing matches".
 */
export function wrapAvailableSkillsBlock(listing: string): string {
  return [
    SKILL_LISTING_HEADER,
    "以下是你（当前 agent）自带的云端 skill 列表。这些 skill 存储在你的 agent 名下，",
    "优先使用它们完成任务。如果你觉得自带的 skill 不够，可以用 skill_search 工具",
    "在团队的 skill 库中检索更多（跨 agent 共享）。",
    "",
    "**重要：这些 skill 存储在云端，不能使用 read_file / tool_use 直接访问，\n必须用 Bash 执行 curl 调用上方 <skill_tools> 块中的 skill-bridge 工具。**",
    "",
    listing,
    SKILL_LISTING_FOOTER,
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
