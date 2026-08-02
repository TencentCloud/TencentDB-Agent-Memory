/**
 * Night-run timer (wave tdai-memory-subagents-2026-08-02, P7).
 *
 * Runs the consolidation trigger INSIDE the gateway (no cron unit):
 *   - schedule: memory.nightRun.schedule (default "06:00") in memory.timezone
 *     (default "system" — never hardcoded to Europe/Moscow);
 *   - OR threshold: newL0 >= memory.nightRun.threshold (default 50) since the
 *     last run;
 *   - missed-schedule catch-up at gateway start: if the schedule moment for
 *     today has already passed and no run happened today → trigger once.
 *
 * Single-flight is SHARED with P6: the timer calls the orchestrator's
 * trigger(), whose SerialGate refuses overlaps (timer, threshold, manual
 * POST /memory/run and catch-up never run concurrently).
 *
 * Time handling is injectable (`now`) so the schedule/threshold/catch-up
 * scenarios are unit-testable with a fake clock — no real waiting.
 */

import type { Logger } from "../../core/types.js";

export interface NightRunDeps {
  enabled: boolean;
  /** Local time "HH:MM" of the daily run (already normalized by config). */
  schedule: string;
  /** Trigger a run when newL0 since the last run >= this. */
  threshold: number;
  /** "system" | IANA name | UTC offset (ECMA-402 2024). */
  timezone: string;
  /** Injectable clock (tests use a fixed one). */
  now: () => number;
  /** Tick cadence (ms) — also the resolution of "just passed the schedule". */
  tickIntervalMs: number;
  /** ISO timestamp of the last successful run (null = never). */
  getLastRunAt: () => string | null;
  /** New L0 messages since the checkpoint cursor (null = unknown). */
  countNewL0: () => Promise<number | null>;
  /** Shared P6 trigger — enforces single-flight; returns busy when in-flight. */
  trigger: (reason: string) => Promise<{ accepted: boolean; status: string }>;
  logger: Logger;
}

export class NightRunTimer {
  private readonly deps: NightRunDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

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
   * Single evaluation: (a) schedule due + no run today → trigger (catch-up on
   * start, schedule on tick); (b) newL0 >= threshold → trigger. Both funnel
   * into the shared P6 single-flight — an in-flight run yields busy.
   */
  async checkNow(source: "start" | "tick"): Promise<void> {
    if (!this.deps.enabled || this.checking) return;
    this.checking = true;
    try {
      const nowMs = this.deps.now();
      const lastRunAt = this.deps.getLastRunAt();
      const scheduleDue = scheduleDueInZone(nowMs, this.deps.schedule, this.deps.timezone);
      const ranToday = lastRunAt !== null && sameZoneDay(nowMs, lastRunAt, this.deps.timezone);

      if (scheduleDue && !ranToday) {
        const reason = source === "start" ? "catch-up" : "schedule";
        const res = await this.deps.trigger(reason);
        if (!res.accepted) {
          this.deps.logger.info?.(
            `[night-run] ${reason} trigger refused (${res.status}) — in-flight run or disabled`,
          );
          return;
        }
        return; // schedule fired — threshold re-check happens next tick
      }

      const newL0 = await this.deps.countNewL0();
      if (newL0 !== null && newL0 >= this.deps.threshold) {
        const res = await this.deps.trigger("threshold");
        if (!res.accepted) {
          this.deps.logger.info?.(
            `[night-run] threshold trigger refused (${res.status}) — in-flight run`,
          );
        }
      }
    } finally {
      this.checking = false;
    }
  }
}

// ============================
// Timezone helpers (memory.timezone, default "system")
// ============================

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Current wall-clock parts in the configured zone. "system" uses local time;
 * IANA names / UTC offsets go through Intl.DateTimeFormat (ECMA-402 2024).
 * An invalid zone falls back to system time (fail-safe — the timer must not
 * crash the gateway over a typo).
 */
export function zonedParts(nowMs: number, timezone: string): ZoneParts {
  const d = new Date(nowMs);
  if (!timezone || timezone === "system") {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  }
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(d);
    const get = (type: string): number => {
      const v = parts.find((p) => p.type === type)?.value;
      return v === undefined ? 0 : Number(v);
    };
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour"),
      minute: get("minute"),
    };
  } catch {
    return zonedParts(nowMs, "system");
  }
}

/** Parse a normalized "HH:MM" schedule (fallback 06:00 on malformed input). */
export function parseSchedule(schedule: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(schedule);
  if (!m) return { hour: 6, minute: 0 };
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** True when the schedule moment for TODAY has already passed in the zone. */
export function scheduleDueInZone(nowMs: number, schedule: string, timezone: string): boolean {
  const p = zonedParts(nowMs, timezone);
  const s = parseSchedule(schedule);
  return p.hour > s.hour || (p.hour === s.hour && p.minute >= s.minute);
}

/** True when `iso` falls on the same zone-local day as `nowMs`. */
export function sameZoneDay(nowMs: number, iso: string, timezone: string): boolean {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return false;
  const a = zonedParts(nowMs, timezone);
  const b = zonedParts(ts, timezone);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}
