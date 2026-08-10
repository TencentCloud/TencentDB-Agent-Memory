/**
 * Role dispatcher (tz-01 B6): WHICH roles are due right now is decided by
 * each role's own `dispatch` block — trigger kind, cron-ish schedule and
 * threshold — and by that role's OWN `lastRunAt`, never by a global
 * "did anything run today" flag and never by a role name.
 *
 * A role that does not resolve, or is switched off, is skipped WITH a reason
 * (`fail-closed-role`): it must be visible why nothing ran.
 */
import { scheduleDueInZone, sameZoneDay } from "./zone-time.js";
import type { RoleResolution } from "./role-contract-types.js";

export interface DueRole {
  role: string;
  /** "catch-up" | "schedule" | "threshold" — goes into the run report. */
  reason: string;
}

/** Pre-tz-01 dispatch: one schedule and one threshold for two named roles.
 * Present only while `memory.consolidation.contractDispatch` is false — the
 * documented rollback path. The names are CONFIG VALUES supplied by the
 * caller, never literals in this module. */
export interface LegacyDispatch {
  schedule: string;
  threshold: number;
  scheduleRole: string;
  thresholdRole: string;
}

export interface DispatchInput {
  contracts: readonly RoleResolution[];
  /** `checkpoint.roles` — per-role state, keyed by role name. */
  roleState: Record<string, unknown>;
  nowMs: number;
  timezone: string;
  /** New L0 records since the cursor (null = unknown → no threshold firing). */
  newL0: number | null;
  source: "start" | "tick";
  /** Called once per skipped role so a silent no-run is impossible. */
  onSkip?: (role: string, why: string) => void;
  /** Rollback mode; when set, the roles' own dispatch blocks are ignored. */
  legacy?: LegacyDispatch;
}

/** Failure state of a role: how many runs failed since the last success and
 * when the last one failed. */
export function failureStateOf(
  roleState: Record<string, unknown>,
  role: string,
): { failures: number; lastFailureAt: string | null } {
  const entry = roleState[role];
  if (entry === null || typeof entry !== "object")
    return { failures: 0, lastFailureAt: null };
  const e = entry as { consecutiveFailures?: unknown; lastFailureAt?: unknown };
  return {
    failures:
      typeof e.consecutiveFailures === "number" ? e.consecutiveFailures : 0,
    lastFailureAt:
      typeof e.lastFailureAt === "string" && e.lastFailureAt.length > 0
        ? e.lastFailureAt
        : null,
  };
}

/** Per-role `lastRunAt` from the checkpoint (null = never ran). */
export function lastRunAtOf(
  roleState: Record<string, unknown>,
  role: string,
): string | null {
  const entry = roleState[role];
  if (entry === null || typeof entry !== "object") return null;
  const v = (entry as { lastRunAt?: unknown }).lastRunAt;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function computeDueRoles(input: DispatchInput): DueRole[] {
  const due: DueRole[] = [];
  const legacy = input.legacy;
  for (const res of input.contracts) {
    if (!res.ok) {
      input.onSkip?.(res.role, res.reason);
      continue;
    }
    const c = res.contract;
    if (!c.enabled) {
      input.onSkip?.(c.role, "enabled=false");
      continue;
    }
    // Retry budget (tz-01 B4): a role whose runs keep failing must not
    // re-spawn a sub-session on every tick. The budget is spent per zone-day,
    // so tomorrow's schedule tries again, and a successful run resets it.
    const { failures, lastFailureAt } = failureStateOf(input.roleState, c.role);
    if (
      failures >= c.policy.retryBudget &&
      lastFailureAt !== null &&
      sameZoneDay(input.nowMs, lastFailureAt, input.timezone)
    ) {
      input.onSkip?.(
        c.role,
        `retry budget exhausted (${failures}/${c.policy.retryBudget} failed runs today)`,
      );
      continue;
    }

    const { trigger, schedule, threshold } = legacy
      ? {
          trigger:
            c.role === legacy.scheduleRole
              ? ("schedule" as const)
              : c.role === legacy.thresholdRole
                ? ("threshold" as const)
                : ("manual_only" as const),
          schedule: legacy.schedule,
          threshold: legacy.threshold,
        }
      : c.dispatch;
    const bySchedule = trigger === "schedule" || trigger === "both";
    const byThreshold = trigger === "threshold" || trigger === "both";

    if (bySchedule && schedule !== null) {
      const lastRunAt = lastRunAtOf(input.roleState, c.role);
      const ranToday =
        lastRunAt !== null &&
        sameZoneDay(input.nowMs, lastRunAt, input.timezone);
      if (
        scheduleDueInZone(input.nowMs, schedule, input.timezone) &&
        !ranToday
      ) {
        due.push({
          role: c.role,
          reason: input.source === "start" ? "catch-up" : "schedule",
        });
        continue; // one run per role per pass
      }
    }
    if (
      byThreshold &&
      threshold !== null &&
      input.newL0 !== null &&
      input.newL0 >= threshold
    ) {
      due.push({ role: c.role, reason: "threshold" });
    }
  }
  return due;
}
