/**
 * Profile scope — how an L2/L3 row is addressed and which rows a tenant sees.
 *
 * These are the pure primitives behind profile tenancy: they turn an isolation
 * context into a scope string, a stable row id, and the query conditions that
 * select that scope's rows. Nothing here touches a disk, a bucket or a store.
 *
 * They live apart from `profile-sync.ts` on purpose. Every reader of profile
 * rows needs them — the row-view backend, scene derivation, the gateway — while
 * file synchronisation is one caller among several. Keeping them here lets a
 * caller take the addressing model without dragging in `fs`, `StorageAdapter`
 * and the scene-index machinery.
 *
 * The invariant that binds the three together: **the id and the filter must
 * describe the same set.** Lookup addresses a row by an id hashed from the
 * scope; listing selects rows by column conditions. If the two disagree, one
 * backend contradicts itself — `getObject` returns a file that `listObjects`
 * says does not exist. Design doc D12 ③.
 */

import { createHash } from "node:crypto";

import type { ProfileFilter, ProfileRecord } from "../store/types.js";

export const DEFAULT_PROFILE_SCOPE = "global";

export type ProfileIsolation = { teamId?: string; userId?: string; agentId?: string; sessionId?: string };

export interface ProfileScopeOptions {
  scope?: string;
  isolation?: ProfileIsolation;
}

export function buildProfileIsolationScope(ctx?: ProfileIsolation): string {
  if (!ctx) return DEFAULT_PROFILE_SCOPE;
  const teamId = ctx.teamId || ctx.userId || "default";
  const agentId = ctx.agentId || "default";
  // L2/L3 are team+agent-level memories. L0/L1 keep user/session/task-level
  // isolation, but profiles intentionally ignore userId/sessionId/taskId so
  // one team's agent memory can accumulate across multiple sessions/users.
  return `team:${teamId}|agent:${agentId}`;
}

/**
 * Translate an isolation context into row-query conditions.
 *
 * Isolation reaches profile rows through the *query*, never through the key —
 * see design doc D12 ③. Every row-backed reader must build its filter here so
 * that two readers cannot disagree about which rows a scope contains.
 *
 * The conditions mirror {@link buildProfileIsolationScope}'s collapse: a
 * profile belongs to a (team-or-user, agent) pair, and `userId` only stands in
 * for a missing `teamId`. Constraining `user_id` while a team is present would
 * make listing narrower than lookup, whose id hash ignores it.
 *
 * An absent dimension is pinned to the empty string rather than left
 * unconstrained: rows written without a team store `team_id: ""`, so "no team"
 * is a value to match, not a condition to skip. Skipping it would admit rows
 * from a different scope.
 */
export function profileScopeFilter(
  isolation?: ProfileIsolation,
  extra?: Partial<ProfileFilter>,
): ProfileFilter {
  const filter: ProfileFilter = { ...extra };
  if (!isolation) return filter;

  if (isolation.teamId) {
    filter.teamId = isolation.teamId;
  } else {
    filter.teamId = "";
    filter.userId = isolation.userId ?? "";
  }
  filter.agentId = isolation.agentId ?? "";
  return filter;
}

/**
 * Whether a row lies inside the scope {@link profileScopeFilter} selects.
 *
 * The scope string collapses (team, user) into one slot, so `{teamId: "x"}` and
 * `{userId: "x"}` hash to the same id while their rows carry different columns.
 * Lookup by id could therefore reach a row that listing excludes. Callers that
 * fetch by id run the result through here to close that gap.
 */
export function profileRowInScope(
  row: Pick<ProfileRecord, "teamId" | "userId" | "agentId">,
  isolation?: ProfileIsolation,
): boolean {
  const filter = profileScopeFilter(isolation);
  if (filter.teamId !== undefined && (row.teamId ?? "") !== filter.teamId) return false;
  if (filter.userId !== undefined && (row.userId ?? "") !== filter.userId) return false;
  if (filter.agentId !== undefined && (row.agentId ?? "") !== filter.agentId) return false;
  return true;
}

export function parseProfileIsolationScope(scope: string): ProfileIsolation | undefined {
  const parts = scope.split("|");
  const values: Record<string, string> = {};
  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx <= 0) return undefined;
    values[part.slice(0, idx)] = part.slice(idx + 1);
  }
  if (!values.agent) return undefined;
  const sessionId = values.session ? safeDecodeURIComponent(values.session) : undefined;
  if (values.team) return { teamId: values.team, agentId: values.agent, ...(sessionId ? { sessionId } : {}) };
  if (values.user) return { userId: values.user, agentId: values.agent, ...(sessionId ? { sessionId } : {}) };
  return undefined;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The row id a (scope, type, filename) triple maps to.
 *
 * Deterministic, so writing the same file twice updates one row instead of
 * inserting a second. `\u0000` separates the parts because it cannot appear in
 * any of them, which keeps two different triples from hashing to one id.
 */
export function buildProfileStableId(scope: string, type: "l2" | "l3", filename: string): string {
  const hash = createHash("sha256")
    .update(`${scope}\u0000${type}\u0000${filename}`)
    .digest("hex");
  return `profile:v1:${hash}`;
}
