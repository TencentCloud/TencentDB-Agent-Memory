/**
 * P7 — night-run timer unit tests (fake clock, no real waiting).
 *
 * Covers the four acceptance scenarios: (a) schedule activates, (b) threshold
 * activates, (c) missed-schedule catch-up at start, (d) single-flight blocks
 * overlap (timer does not double-trigger while a run is in flight).
 */
import { describe, it, expect, vi } from "vitest";
import {
  NightRunTimer,
  zonedParts,
  scheduleDueInZone,
  sameZoneDay,
  type NightRunDeps,
} from "./night-run.js";
import type { Logger } from "../../core/types.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Fixed instants (UTC). 2026-08-02T03:01:00Z == 06:01 MSK (Europe/Moscow). */
const MSK_0601 = Date.UTC(2026, 7, 2, 3, 1, 0); // 06:01 MSK
const MSK_0230 = Date.UTC(2026, 7, 2, 0, 30, 0); // 02:30 MSK — before schedule
const YESTERDAY_MSK = "2026-08-01T03:00:00.000Z"; // yesterday 06:00 MSK

function makeTimer(overrides: Partial<NightRunDeps> = {}): {
  timer: NightRunTimer;
  trigger: ReturnType<typeof vi.fn>;
  getLastRunAt: () => string | null;
  countNewL0: ReturnType<typeof vi.fn>;
  deps: () => NightRunDeps;
} {
  const state: { lastRunAt: string | null } = { lastRunAt: YESTERDAY_MSK };
  const trigger = vi.fn(async (reason: string) => ({
    accepted: true,
    status: "started" as const,
    reason,
  }));
  const countNewL0 = vi.fn(async () => 0);
  const deps: NightRunDeps = {
    enabled: true,
    schedule: "06:00",
    threshold: 50,
    timezone: "Europe/Moscow",
    now: () => MSK_0601,
    tickIntervalMs: 1000,
    getLastRunAt: () => state.lastRunAt,
    countNewL0: () => countNewL0(),
    trigger: (reason: string) => trigger(reason),
    logger: silentLogger,
    ...overrides,
  };
  const timer = new NightRunTimer(deps);
  return {
    timer,
    trigger,
    countNewL0,
    getLastRunAt: () => state.lastRunAt,
    deps: () => deps,
  };
}

describe("zone helpers", () => {
  it("zonedParts maps a UTC instant into Europe/Moscow wall clock", () => {
    const p = zonedParts(MSK_0601, "Europe/Moscow");
    expect(p.hour).toBe(6);
    expect(p.minute).toBe(1);
    expect(p.day).toBe(2);
  });

  it("scheduleDueInZone is false before the schedule moment and true after", () => {
    expect(scheduleDueInZone(MSK_0230, "06:00", "Europe/Moscow")).toBe(false);
    expect(scheduleDueInZone(MSK_0601, "06:00", "Europe/Moscow")).toBe(true);
  });

  it("sameZoneDay distinguishes today from yesterday in the zone", () => {
    expect(sameZoneDay(MSK_0601, YESTERDAY_MSK, "Europe/Moscow")).toBe(false);
    // 2026-08-02T03:01:00Z == 06:01 MSK — same day as a 04:00 MSK instant.
    expect(
      sameZoneDay(MSK_0601, "2026-08-02T01:00:00.000Z", "Europe/Moscow"),
    ).toBe(true);
  });

  it("invalid timezone falls back to system time (fail-safe, no throw)", () => {
    expect(() => zonedParts(MSK_0601, "Not/AZone")).not.toThrow();
  });
});

describe("NightRunTimer (P7)", () => {
  it("(a) schedule activates a run when due and no run happened today", async () => {
    const { timer, trigger } = makeTimer(); // now = 06:01 MSK, last run yesterday
    await timer.checkNow("tick");
    expect(trigger).toHaveBeenCalledWith("schedule");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("(a-neg) schedule does NOT re-trigger when a run already happened today", async () => {
    const state = { lastRunAt: "2026-08-02T02:00:00.000Z" }; // today 05:00 MSK
    const trigger = vi.fn(async (reason: string) => ({
      accepted: true,
      status: "started" as const,
      reason,
    }));
    const timer = new NightRunTimer({
      enabled: true,
      schedule: "06:00",
      threshold: 50,
      timezone: "Europe/Moscow",
      now: () => MSK_0601,
      tickIntervalMs: 1000,
      getLastRunAt: () => state.lastRunAt,
      countNewL0: async () => 0,
      trigger: (reason: string) => trigger(reason),
      logger: silentLogger,
    });
    await timer.checkNow("tick");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("(b) threshold activates when newL0 >= threshold (schedule not yet due)", async () => {
    const { timer, trigger, countNewL0 } = makeTimer({ now: () => MSK_0230 });
    countNewL0.mockResolvedValue(60);
    await timer.checkNow("tick");
    expect(trigger).toHaveBeenCalledWith("threshold");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("(B5) schedule fires the NIGHT role (runType=night-keeper), threshold fires day keeper", async () => {
    // schedule → night-keeper
    const calls: Array<[string, string | undefined]> = [];
    const mkTimer = (now: number) => {
      const trigger = vi.fn(async (_r: string, _rt?: string) => ({
        accepted: true,
        status: "started" as const,
        reason: _r,
      }));
      const timer = new NightRunTimer({
        enabled: true,
        schedule: "06:00",
        threshold: 50,
        timezone: "Europe/Moscow",
        now: () => now,
        tickIntervalMs: 1000,
        getLastRunAt: () => YESTERDAY_MSK,
        countNewL0: async () => 0,
        trigger: (reason: string, runType?: string) => {
          calls.push([reason, runType]);
          return trigger(reason, runType);
        },
        logger: silentLogger,
      });
      return { timer, trigger };
    };

    // (1) schedule due (06:01 MSK) → night-keeper
    const sched = mkTimer(MSK_0601);
    await sched.timer.checkNow("tick");
    expect(sched.trigger).toHaveBeenCalledWith("schedule", "night-keeper");

    // (2) threshold crossing (02:30 MSK, newL0=60) → day keeper (no runType)
    const thr = mkTimer(MSK_0230);
    const count = vi.fn(async () => 60);
    const timer2 = new NightRunTimer({
      enabled: true,
      schedule: "06:00",
      threshold: 50,
      timezone: "Europe/Moscow",
      now: () => MSK_0230,
      tickIntervalMs: 1000,
      getLastRunAt: () => YESTERDAY_MSK,
      countNewL0: count,
      trigger: (reason: string, runType?: string) => {
        calls.push([reason, runType]);
        return Promise.resolve({
          accepted: true,
          status: "started" as const,
          reason,
        });
      },
      logger: silentLogger,
    });
    await timer2.checkNow("tick");
    expect(calls.some(([r, rt]) => r === "threshold" && rt === undefined)).toBe(
      true,
    );
  });

  it("(B5) threshold refused by busy night → deferred day retry hook fires", async () => {
    const deferred = vi.fn();
    const trigger = vi.fn(async (_r: string) => ({
      accepted: false,
      status: "busy" as const,
      reason: _r,
    }));
    const timer = new NightRunTimer({
      enabled: true,
      schedule: "06:00",
      threshold: 50,
      timezone: "Europe/Moscow",
      now: () => MSK_0230,
      tickIntervalMs: 1000,
      getLastRunAt: () => YESTERDAY_MSK,
      countNewL0: async () => 60,
      trigger: (reason: string) => trigger(reason),
      onThresholdDeferred: deferred,
      logger: silentLogger,
    });
    await timer.checkNow("tick");
    expect(deferred).toHaveBeenCalledTimes(1);
  });

  it("(b-neg) threshold below limit does not trigger", async () => {
    const { timer, trigger, countNewL0 } = makeTimer({ now: () => MSK_0230 });
    countNewL0.mockResolvedValue(49);
    await timer.checkNow("tick");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("(c) missed-schedule catch-up fires once at start when the schedule passed", async () => {
    const { timer, trigger } = makeTimer(); // start at 06:01 MSK, no run today
    await timer.checkNow("start");
    expect(trigger).toHaveBeenCalledWith("catch-up");
  });

  it("(c-neg) no catch-up when a run already happened today", async () => {
    const trigger2 = vi.fn(async (reason: string) => ({
      accepted: true,
      status: "started" as const,
      reason,
    }));
    const timer2 = new NightRunTimer({
      enabled: true,
      schedule: "06:00",
      threshold: 50,
      timezone: "Europe/Moscow",
      now: () => MSK_0601,
      tickIntervalMs: 1000,
      getLastRunAt: () => "2026-08-02T02:00:00.000Z",
      countNewL0: async () => 0,
      trigger: (reason: string) => trigger2(reason),
      logger: silentLogger,
    });
    await timer2.checkNow("start");
    expect(trigger2).not.toHaveBeenCalled();
  });

  it("(d) single-flight: busy trigger is not retried — no overlap", async () => {
    let calls = 0;
    const trigger = vi.fn(async (reason: string) => {
      calls++;
      return { accepted: false, status: "busy" as const, reason };
    });
    const countNewL0 = vi.fn(async () => 0);
    const timer = new NightRunTimer({
      enabled: true,
      schedule: "06:00",
      threshold: 50,
      timezone: "Europe/Moscow",
      now: () => MSK_0601,
      tickIntervalMs: 1000,
      getLastRunAt: () => YESTERDAY_MSK,
      countNewL0: () => countNewL0(),
      trigger: (reason: string) => trigger(reason),
      logger: silentLogger,
    });
    await timer.checkNow("tick");
    expect(calls).toBe(1); // schedule path refused → returns, no threshold retry
    expect(countNewL0).not.toHaveBeenCalled();
  });

  it("disabled timer does nothing (no catch-up, no triggers)", async () => {
    const trigger = vi.fn(async () => ({
      accepted: true,
      status: "started" as const,
      reason: "x",
    }));
    const timer = new NightRunTimer({
      enabled: false,
      schedule: "06:00",
      threshold: 50,
      timezone: "Europe/Moscow",
      now: () => MSK_0601,
      tickIntervalMs: 1000,
      getLastRunAt: () => null,
      countNewL0: async () => 500,
      trigger: (reason: string) => trigger(reason),
      logger: silentLogger,
    });
    timer.start();
    await timer.checkNow("start");
    await timer.checkNow("tick");
    expect(trigger).not.toHaveBeenCalled();
    timer.stop();
  });
});
