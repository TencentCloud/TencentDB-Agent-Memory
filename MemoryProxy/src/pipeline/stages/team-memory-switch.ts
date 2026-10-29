/**
 * stages/team-memory-switch.ts — read the instance-level team_memory master
 * switch BEFORE session-init orchestration.
 *
 * Placement: AFTER stageResolveUserId / stageInstanceUpstreamEarly, BEFORE
 * stageSessionInitOrchestrate. Flipping the switch to "0" at Core causes:
 *   1. the 4 runner entry `if` → bypass (sessionInfo=undefined, injectedSkipped=true)
 *   2. stageAssetCapabilities short-circuits (its own !sessionInfo guard)
 *   3. stagePrewarmInjection + stageInjectionRunner short-circuit
 *   4. stageMemCommandIntercept / stageSessionResetPreHook / skill-bridge /
 *      memory-bridge are additionally gated for safety.
 *
 * Everything NOT on the team-memory path (cost-guard router, credit, rate-limit,
 * instance-upstream override, /direct passthrough, systemUser) runs unchanged.
 *
 * Design: `MemoryProxy/docs/design/2026-10-13-team-memory-master-switch.md` §6.2.
 */

import type { ProxyConfig } from "../../types.js";

export interface TeamMemorySwitchInput {
  config: ProxyConfig;
  /** instance_id override from the request path (preferred over config.tdai.serviceId). */
  spaceId?: string | null;
  /** TDAI user key for the caller (same as stageAssetCapabilities). */
  userKey: string | null | undefined;
  /** user_id (same as stageAssetCapabilities). */
  userId?: string | null;
}

/**
 * Returns whether team memory is enabled for the current instance.
 * Any failure → `true` (fail-open, backward compatible with older Core).
 */
export async function stageTeamMemorySwitch(input: TeamMemorySwitchInput): Promise<boolean> {
  try {
    const { fetchTeamMemoryEnabled } = await import("../../tdai/team-memory-switch.js");
    const instanceId = input.spaceId?.trim() || input.config.tdai.serviceId;
    return await fetchTeamMemoryEnabled({
      endpoint: input.config.tdai.endpoint,
      apiKey: input.config.tdai.apiKey,
      instanceId,
      userKey: input.userKey ?? null,
      userId: input.userId ?? null,
      timeoutMs: input.config.tdai.memory.timeoutMs,
    });
  } catch (err) {
    console.warn(
      "[team-memory-switch] stage error:",
      err instanceof Error ? err.message : String(err),
    );
    return true; // fail-open; keeps existing behavior if the module throws.
  }
}
