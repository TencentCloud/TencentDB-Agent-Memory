/**
 * Role timer (wave tdai-memory-subagents-2026-08-02, P7; contract-driven
 * since tz-01 B6).
 *
 * Runs role dispatch INSIDE the gateway (no cron unit): every tick it asks
 * the dispatcher which roles are due, from each role's own contract
 * (`dispatch.trigger` / `schedule` / `threshold`) and its own `lastRunAt` in
 * the checkpoint — the timer itself knows no role names and no schedule.
 * A schedule moment missed while the gateway was down is caught up once at
 * start.
 *
 * Single-flight is SHARED with P6: the timer calls the orchestrator's
 * trigger(), whose per-role gate refuses overlaps (timer, threshold, manual
 * POST /memory/run and catch-up never run concurrently).
 *
 * Time handling is injectable (`now`) so the schedule/threshold/catch-up
 * scenarios are unit-testable with a fake clock — no real waiting.
 */

import { computeDueRoles } from "./dispatcher.js";
import type { LegacyDispatch } from "./dispatcher.js";
import type { RoleResolution } from "./role-contract-types.js";
import type { Logger } from "../../core/types.js";

export interface NightRunDeps {
  enabled: boolean;
  /** "system" | IANA name | UTC offset (ECMA-402 2024). */
  timezone: string;
  /** Injectable clock (tests use a fixed one). */
  now: () => number;
  /** Tick cadence (ms) — also the resolution of "just passed the schedule". */
  tickIntervalMs: number;
  /** All role contracts, re-resolved each pass (an edited role.json takes
   * effect without a gateway restart; the resolver is cached by mtime). */
  listRoleContracts: () => readonly RoleResolution[];
  /** Consolidation checkpoint — `roles[<role>].lastRunAt` per role. */
  readCheckpoint: () => Promise<{ roles?: Record<string, unknown> }>;
  /** New L0 messages since the checkpoint cursor (null = unknown). */
  countNewL0: () => Promise<number | null>;
  /** Shared P6 trigger — enforces single-flight; returns busy when in-flight. */
  trigger: (
    reason: string,
    runType?: string,
  ) => Promise<{ accepted: boolean; status: string }>;
  logger: Logger;
  /** Rollback (`memory.consolidation.contractDispatch: false`): dispatch by
   * the single global schedule/threshold instead of the role contracts. */
  legacyDispatch?: LegacyDispatch;
  /** Optional deferred-retry hook: when a threshold run is refused because
   * another run holds the per-role gate, the timer asks the caller to retry
   * after it finishes (no data loss). */
  onThresholdDeferred?: () => void;
}

export class NightRunTimer {
  private readonly deps: NightRunDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  /** Roles already reported as skipped — one log line per role, not per tick. */
  private readonly loggedSkips = new Set<string>();

  constructor(deps: NightRunDeps) {
    this.deps = deps;
  }

  /** Start the timer + immediate catch-up check. No-op when disabled. */
  start(): void {
    if (!this.deps.enabled) return;
    void this.checkNow("start");
    this.timer = setInterval(() => {
      void this.checkNow("tick");
    }, this.deps.tickIntervalMs);
    // Do not keep the process alive on tests/CLI exits.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Single evaluation: ask the dispatcher which roles are due and trigger
   * each one. Every trigger funnels into the shared P6 single-flight — a
   * role whose run is in flight yields busy.
   */
  async checkNow(source: "start" | "tick"): Promise<void> {
    if (!this.deps.enabled || this.checking) return;
    this.checking = true;
    try {
      const cp = await this.deps.readCheckpoint();
      const due = computeDueRoles({
        contracts: this.deps.listRoleContracts(),
        roleState: cp.roles ?? {},
        nowMs: this.deps.now(),
        timezone: this.deps.timezone,
        newL0: await this.deps.countNewL0(),
        source,
        onSkip: (role, why) => this.logSkip(role, why),
        legacy: this.deps.legacyDispatch,
      });

      for (const { role, reason } of due) {
        const res = await this.deps.trigger(reason, role);
        if (res.accepted) continue;
        this.deps.logger.info?.(
          `[night-run] ${reason} trigger for ${role} refused (${res.status}) — in-flight run or disabled`,
        );
        if (
          reason === "threshold" &&
          res.status === "busy" &&
          this.deps.onThresholdDeferred
        ) {
          // Another run holds the per-role gate — schedule a deferred retry
          // instead of dropping the threshold crossing.
          this.deps.onThresholdDeferred();
        }
      }
    } finally {
      this.checking = false;
    }
  }

  private logSkip(role: string, why: string): void {
    if (this.loggedSkips.has(role)) return;
    this.loggedSkips.add(role);
    this.deps.logger.info?.(
      `[night-run] role ${role} not dispatchable: ${why}`,
    );
  }
}

// Timezone helpers moved to zone-time.ts (night-run.ts stays within the
// module size convention); re-exported for existing importers.
export {
  zonedParts,
  parseSchedule,
  scheduleDueInZone,
  sameZoneDay,
  type ZoneParts,
} from "./zone-time.js";
