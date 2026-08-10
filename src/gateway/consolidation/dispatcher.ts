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
    const { trigger, schedule, threshold } = c.dispatch;
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
