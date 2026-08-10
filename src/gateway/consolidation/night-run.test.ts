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
import type {
  ResolvedRoleContract,
  RoleResolution,
} from "./role-contract-types.js";
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

/**
 * Synthetic role contracts: the timer no longer knows any schedule or role
 * name, it asks the dispatcher, so a fixture IS a set of contracts plus the
 * per-role `lastRunAt` in the checkpoint (tz-01 B6).
 */
function roleContract(
  role: string,
  dispatch: Partial<ResolvedRoleContract["dispatch"]> & {
    trigger: ResolvedRoleContract["dispatch"]["trigger"];
  },
  enabled = true,
): RoleResolution {
  return {
    ok: true,
    contract: {
      role,
      enabled,
      dispatch: { schedule: null, threshold: null, ...dispatch },
    } as ResolvedRoleContract,
  };
}

const DAY_ROLE = roleContract("memory-keeper", {
  trigger: "threshold",
  threshold: 50,
});
const NIGHT_ROLE = roleContract("night-keeper", {
  trigger: "schedule",
  schedule: "06:00",
});

function makeTimer(
  overrides: Partial<NightRunDeps> = {},
  lastRunAt: Record<string, string> = { "night-keeper": YESTERDAY_MSK },
): {
  timer: NightRunTimer;
  trigger: ReturnType<typeof vi.fn>;
  countNewL0: ReturnType<typeof vi.fn>;
} {
  const trigger = vi.fn(async (reason: string, _role?: string) => ({
    accepted: true,
    status: "started" as const,
    reason,
  }));
  const countNewL0 = vi.fn(async () => 0);
  const timer = new NightRunTimer({
    enabled: true,
    timezone: "Europe/Moscow",
    now: () => MSK_0601,
    tickIntervalMs: 1000,
    listRoleContracts: () => [DAY_ROLE, NIGHT_ROLE],
    readCheckpoint: async () => ({
      roles: Object.fromEntries(
        Object.entries(lastRunAt).map(([r, at]) => [r, { lastRunAt: at }]),
      ),
    }),
    countNewL0: () => countNewL0(),
    trigger: (reason: string, role?: string) => trigger(reason, role),
    logger: silentLogger,
    ...overrides,
  });
  return { timer, trigger, countNewL0 };
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

describe("NightRunTimer (P7, contract-driven dispatch)", () => {
  it("(a) schedule activates a run when due and the role has not run today", async () => {
    const { timer, trigger } = makeTimer(); // 06:01 MSK, night ran yesterday
    await timer.checkNow("tick");
    expect(trigger).toHaveBeenCalledWith("schedule", "night-keeper");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("(a-neg) schedule does NOT re-trigger when THAT role already ran today", async () => {
    const { timer, trigger } = makeTimer(
      {},
      { "night-keeper": "2026-08-02T02:00:00.000Z" }, // today 05:00 MSK
    );
    await timer.checkNow("tick");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("(B6) ranToday is PER ROLE: a second scheduled role still fires", async () => {
    const dedup = roleContract("dedup-daily", {
      trigger: "schedule",
      schedule: "03:00",
    });
    const { timer, trigger } = makeTimer(
      { listRoleContracts: () => [NIGHT_ROLE, dedup] },
      { "night-keeper": "2026-08-02T02:00:00.000Z" }, // night ran today
    );
    await timer.checkNow("tick");
    // The night role is done for today; dedup-daily has its own lastRunAt.
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith("schedule", "dedup-daily");
  });

  it("(b) threshold activates when newL0 >= the ROLE's threshold", async () => {
    const { timer, trigger, countNewL0 } = makeTimer({ now: () => MSK_0230 });
    countNewL0.mockResolvedValue(60);
    await timer.checkNow("tick");
    expect(trigger).toHaveBeenCalledWith("threshold", "memory-keeper");
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("(B5) schedule fires the night role, threshold fires the day role", async () => {
    const sched = makeTimer();
    await sched.timer.checkNow("tick");
    expect(sched.trigger).toHaveBeenCalledWith("schedule", "night-keeper");

    const thr = makeTimer({ now: () => MSK_0230 });
    thr.countNewL0.mockResolvedValue(60);
    await thr.timer.checkNow("tick");
    expect(thr.trigger).toHaveBeenCalledWith("threshold", "memory-keeper");
  });

  it("(B5) threshold refused as busy → deferred retry hook fires", async () => {
    const deferred = vi.fn();
    const { timer } = makeTimer({
      now: () => MSK_0230,
      countNewL0: async () => 60,
      onThresholdDeferred: deferred,
      trigger: async (reason: string) => ({
        accepted: false,
        status: "busy",
        reason,
      }),
    });
    await timer.checkNow("tick");
    expect(deferred).toHaveBeenCalledTimes(1);
  });

  it("(b-neg) threshold below the role limit does not trigger", async () => {
    const { timer, trigger, countNewL0 } = makeTimer({ now: () => MSK_0230 });
    countNewL0.mockResolvedValue(49);
    await timer.checkNow("tick");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("(c) missed-schedule catch-up fires once at start when the schedule passed", async () => {
    const { timer, trigger } = makeTimer();
    await timer.checkNow("start");
    expect(trigger).toHaveBeenCalledWith("catch-up", "night-keeper");
  });

  it("(c-neg) no catch-up when that role already ran today", async () => {
    const { timer, trigger } = makeTimer(
      {},
      { "night-keeper": "2026-08-02T02:00:00.000Z" },
    );
    await timer.checkNow("start");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("(d) single-flight: a busy trigger is not retried — no overlap", async () => {
    let calls = 0;
    const { timer } = makeTimer({
      trigger: async (reason: string) => {
        calls++;
        return { accepted: false, status: "busy", reason };
      },
    });
    await timer.checkNow("tick");
    expect(calls).toBe(1); // the due role was offered once, then dropped
  });

  it("a role that does not resolve is skipped, the others still run", async () => {
    const broken: RoleResolution = {
      ok: false,
      role: "broken-role",
      reason: "role.json is not valid JSON",
    };
    const logged: string[] = [];
    const { timer, trigger } = makeTimer({
      listRoleContracts: () => [broken, NIGHT_ROLE],
      logger: { ...silentLogger, info: (m: string) => void logged.push(m) },
    });
    await timer.checkNow("tick");
    expect(trigger).toHaveBeenCalledWith("schedule", "night-keeper");
    expect(logged.some((m) => m.includes("broken-role"))).toBe(true);
  });

  it("enabled=false role is never dispatched", async () => {
    const off = roleContract(
      "off-role",
      { trigger: "schedule", schedule: "06:00" },
      false,
    );
    const { timer, trigger } = makeTimer({ listRoleContracts: () => [off] });
    await timer.checkNow("tick");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("disabled timer does nothing (no catch-up, no triggers)", async () => {
    const { timer, trigger } = makeTimer({ enabled: false });
    timer.start();
    await timer.checkNow("start");
    await timer.checkNow("tick");
    expect(trigger).not.toHaveBeenCalled();
    timer.stop();
  });
});
