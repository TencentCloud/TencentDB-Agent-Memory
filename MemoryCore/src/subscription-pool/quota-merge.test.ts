import { describe, expect, it } from "vitest";
import type { SubscriptionQuotaWindow } from "../metadata/types.js";
import { applyQuotaReport } from "../metadata/subscription-pool/quota-report.js";
import { mergeUsageWindows } from "./quota-merge.js";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = 1_800_000_000_000;

function win(partial: Partial<SubscriptionQuotaWindow>): SubscriptionQuotaWindow {
  return { name: "primary_window", model_scope: null, used_pct: 10, resets_at: T0 + 60 * MIN, observed_at: T0, source: "usage_api", ...partial };
}

describe("mergeUsageWindows", () => {
  it("keeps the newest observation per window", () => {
    const merged = mergeUsageWindows(
      [win({ used_pct: 50, observed_at: T0 + 2 * MIN })],
      [win({ used_pct: 20, observed_at: T0 + MIN })],
    );
    expect(merged).toEqual([win({ used_pct: 50, observed_at: T0 + 2 * MIN })]);
  });

  it("keeps windows of other models apart", () => {
    const merged = mergeUsageWindows(
      [win({ name: "weekly", model_scope: null })],
      [win({ name: "weekly", model_scope: "gpt-5-codex", used_pct: 99 })],
    );
    expect(merged).toHaveLength(2);
  });

  it("keeps a 429 window at 100 % until its reset, then accepts newer readings", () => {
    const limited = win({ used_pct: 100, source: "429", observed_at: T0, resets_at: T0 + 10 * MIN });
    expect(mergeUsageWindows([limited], [win({ used_pct: 30, observed_at: T0 + 5 * MIN })])).toEqual([limited]);
    const after = win({ used_pct: 3, observed_at: T0 + 11 * MIN });
    expect(mergeUsageWindows([limited], [after])).toEqual([after]);
  });

  it("does not freeze a 429 window that has no reset time", () => {
    const limited = win({ used_pct: 100, source: "429", resets_at: null });
    const reading = win({ used_pct: 40, observed_at: T0 + 20 * MIN });
    expect(mergeUsageWindows([limited], [reading])).toEqual([reading]);
  });

  it("lets a 429 win over a reading observed at the same time", () => {
    const reading = win({ used_pct: 60, observed_at: T0 });
    const limited = win({ used_pct: 100, source: "429", observed_at: T0 });
    expect(mergeUsageWindows([reading], [limited])).toEqual([limited]);
  });
});

describe("applyQuotaReport", () => {
  const base = { status: "active" as const, exhausted_until: null };

  it("marks the account exhausted for 15 minutes on a 429 without any reset time", () => {
    const result = applyQuotaReport({ ...base, usage: { windows: [] } }, { status_code: 429 }, T0);
    expect(result.status).toBe("exhausted");
    expect(result.exhausted_until).toBe(T0 + 15 * MIN);
  });

  it("uses the earliest window reset on a 429 without retry-after", () => {
    const usage = { windows: [win({ resets_at: T0 + 30 * MIN }), win({ name: "secondary_window", resets_at: T0 + 2 * DAY })] };
    const result = applyQuotaReport({ ...base, usage }, { status_code: 429 }, T0);
    expect(result.exhausted_until).toBe(T0 + 30 * MIN);
  });

  it("caps the reset of each 429 window at retry-after so the reset check can release it", () => {
    const usage = { windows: [win({ name: "secondary_window", used_pct: 40, resets_at: T0 + 6 * DAY })] };
    const reported = applyQuotaReport({ ...base, usage }, { status_code: 429, retry_after: 300 }, T0);
    expect(reported.exhausted_until).toBe(T0 + 5 * MIN);
    expect(reported.usage?.windows[0]).toMatchObject({ used_pct: 100, source: "429", resets_at: T0 + 5 * MIN });

    const reading = win({ name: "secondary_window", used_pct: 40, observed_at: T0 + 5 * MIN + 30_000, resets_at: T0 + 6 * DAY });
    expect(mergeUsageWindows(reported.usage!.windows, [reading])).toEqual([reading]);
  });

  it("does not let an older header reading undo a newer one", () => {
    const usage = { windows: [win({ used_pct: 80, observed_at: T0 + 2 * MIN })] };
    const result = applyQuotaReport({ ...base, usage }, { windows: [win({ used_pct: 20, observed_at: T0 + MIN })] }, T0 + 3 * MIN);
    expect(result.usage?.windows[0].used_pct).toBe(80);
  });

  it.each(["auth_error", "disabled"] as const)("does not change status %s on a 429", (status) => {
    const result = applyQuotaReport({ status, exhausted_until: null, usage: { windows: [] } }, { status_code: 429 }, T0);
    expect(result.status).toBeUndefined();
  });

  it("writes no status or exhaustion for a report without a 429", () => {
    const result = applyQuotaReport({ ...base, usage: { windows: [] } }, { active_sessions: 2 }, T0);
    expect(result.status).toBeUndefined();
    expect(result.exhausted_until).toBeUndefined();
    expect(result.active_sessions).toBe(2);
  });
});
