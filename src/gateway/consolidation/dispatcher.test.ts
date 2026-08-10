/**
 * tz-01 criterion 6 — WHICH roles are due comes from each role's own
 * contract and its own `lastRunAt`, not from a global flag or a role name.
 * Also covers the documented rollback (`contractDispatch: false`).
 */
import { describe, it, expect } from "vitest";
import { computeDueRoles, lastRunAtOf } from "./dispatcher.js";
import type {
  ResolvedRoleContract,
  RoleResolution,
} from "./role-contract-types.js";

const MSK_0301 = Date.UTC(2026, 7, 2, 0, 1, 0); // 03:01 Europe/Moscow
const MSK_0230 = Date.UTC(2026, 7, 2, 0, 30, 0) - 60 * 60 * 1000; // 02:30 MSK
const YESTERDAY = "2026-08-01T00:05:00.000Z";
const TZ = "Europe/Moscow";

function role(
  name: string,
  dispatch: Partial<ResolvedRoleContract["dispatch"]> & {
    trigger: ResolvedRoleContract["dispatch"]["trigger"];
  },
  enabled = true,
): RoleResolution {
  return {
    ok: true,
    contract: {
      role: name,
      enabled,
      dispatch: { schedule: null, threshold: null, ...dispatch },
      policy: { retryBudget: 2 },
    } as ResolvedRoleContract,
  };
}

const DEDUP = role("dedup-daily", { trigger: "schedule", schedule: "03:00" });
const NIGHT = role("night-keeper", { trigger: "schedule", schedule: "06:00" });
const DAY = role("memory-keeper", { trigger: "threshold", threshold: 50 });

const base = {
  nowMs: MSK_0301,
  timezone: TZ,
  newL0: 0,
  source: "tick" as const,
};

describe("computeDueRoles (tz-01 B6)", () => {
  it("a scheduled role whose time passed and did not run today is due", () => {
    const due = computeDueRoles({
      ...base,
      contracts: [DEDUP, NIGHT],
      roleState: { "dedup-daily": { lastRunAt: YESTERDAY } },
    });
    // 03:01 MSK: dedup-daily (03:00) is due, night-keeper (06:00) is not.
    expect(due).toEqual([{ role: "dedup-daily", reason: "schedule" }]);
  });

  it("enabled=false is never due (the operator's off switch)", () => {
    const off = role(
      "dedup-daily",
      { trigger: "schedule", schedule: "03:00" },
      false,
    );
    const skipped: string[] = [];
    const due = computeDueRoles({
      ...base,
      contracts: [off],
      roleState: {},
      onSkip: (r, why) => skipped.push(`${r}:${why}`),
    });
    expect(due).toEqual([]);
    expect(skipped).toEqual(["dedup-daily:enabled=false"]);
  });

  it("ranToday is read from checkpoint.roles[role], not from a global flag", () => {
    const due = computeDueRoles({
      ...base,
      contracts: [DEDUP],
      // Another role ran today; dedup-daily itself did not.
      roleState: {
        "night-keeper": { lastRunAt: "2026-08-02T00:00:00.000Z" },
        "dedup-daily": { lastRunAt: YESTERDAY },
      },
    });
    expect(due).toEqual([{ role: "dedup-daily", reason: "schedule" }]);

    const already = computeDueRoles({
      ...base,
      contracts: [DEDUP],
      roleState: { "dedup-daily": { lastRunAt: "2026-08-02T00:00:30.000Z" } },
    });
    expect(already).toEqual([]);
  });

  it("source=start reports the run as a catch-up", () => {
    const due = computeDueRoles({
      ...base,
      source: "start",
      contracts: [DEDUP],
      roleState: {},
    });
    expect(due[0]?.reason).toBe("catch-up");
  });

  it("threshold fires on the ROLE's own threshold", () => {
    const under = computeDueRoles({
      ...base,
      nowMs: MSK_0230,
      contracts: [DAY],
      roleState: {},
      newL0: 49,
    });
    expect(under).toEqual([]);
    const over = computeDueRoles({
      ...base,
      nowMs: MSK_0230,
      contracts: [DAY],
      roleState: {},
      newL0: 50,
    });
    expect(over).toEqual([{ role: "memory-keeper", reason: "threshold" }]);
  });

  it("an unresolved role is skipped WITH its reason, never silently", () => {
    const broken: RoleResolution = {
      ok: false,
      role: "broken",
      reason: "role.json is not valid JSON",
    };
    const skipped: string[] = [];
    const due = computeDueRoles({
      ...base,
      contracts: [broken, DEDUP],
      roleState: {},
      onSkip: (r, why) => skipped.push(`${r}:${why}`),
    });
    expect(due.map((d) => d.role)).toEqual(["dedup-daily"]);
    expect(skipped[0]).toContain("broken:role.json is not valid JSON");
  });

  it("manual_only is never dispatched", () => {
    const manual = role("smoke-role", { trigger: "manual_only" });
    expect(
      computeDueRoles({ ...base, contracts: [manual], roleState: {} }),
    ).toEqual([]);
  });

  it("retry budget: a role that keeps failing today stops being dispatched", () => {
    const failedToday = {
      "dedup-daily": {
        lastRunAt: YESTERDAY,
        consecutiveFailures: 2,
        lastFailureAt: "2026-08-02T00:00:30.000Z", // today, 03:00:30 MSK
      },
    };
    const skipped: string[] = [];
    const due = computeDueRoles({
      ...base,
      contracts: [DEDUP],
      roleState: failedToday,
      onSkip: (r, why) => skipped.push(`${r}: ${why}`),
    });
    expect(due).toEqual([]);
    expect(skipped[0]).toContain("retry budget exhausted (2/2");
  });

  it("retry budget: one failure is still under the budget → the role retries", () => {
    const due = computeDueRoles({
      ...base,
      contracts: [DEDUP],
      roleState: {
        "dedup-daily": {
          lastRunAt: YESTERDAY,
          consecutiveFailures: 1,
          lastFailureAt: "2026-08-02T00:00:30.000Z",
        },
      },
    });
    expect(due).toEqual([{ role: "dedup-daily", reason: "schedule" }]);
  });

  it("retry budget resets on a new zone-day (yesterday's failures do not block)", () => {
    const due = computeDueRoles({
      ...base,
      contracts: [DEDUP],
      roleState: {
        "dedup-daily": {
          lastRunAt: YESTERDAY,
          consecutiveFailures: 9,
          lastFailureAt: YESTERDAY,
        },
      },
    });
    expect(due).toEqual([{ role: "dedup-daily", reason: "schedule" }]);
  });

  it("rollback (contractDispatch=false): one schedule, configured roles", () => {
    const due = computeDueRoles({
      ...base,
      contracts: [DEDUP, NIGHT, DAY],
      roleState: {},
      legacy: {
        schedule: "03:00",
        threshold: 50,
        scheduleRole: "night-keeper",
        thresholdRole: "memory-keeper",
      },
    });
    // The roles' own dispatch blocks are ignored: only the configured
    // schedule role fires; dedup-daily is back to manual.
    expect(due).toEqual([{ role: "night-keeper", reason: "schedule" }]);
  });
});

describe("lastRunAtOf", () => {
  it("returns null for a missing or malformed entry", () => {
    expect(lastRunAtOf({}, "x")).toBeNull();
    expect(lastRunAtOf({ x: 5 }, "x")).toBeNull();
    expect(lastRunAtOf({ x: { lastRunAt: "" } }, "x")).toBeNull();
    expect(lastRunAtOf({ x: { lastRunAt: "2026-08-01T00:00:00Z" } }, "x")).toBe(
      "2026-08-01T00:00:00Z",
    );
  });
});
