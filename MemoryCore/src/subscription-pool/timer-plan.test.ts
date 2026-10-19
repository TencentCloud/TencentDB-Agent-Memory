import { describe, expect, it } from "vitest";
import type { SubscriptionAccountEntity, SubscriptionQuotaWindow } from "../metadata/types.js";
import { planAccountTimers } from "./timer-plan.js";

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

function account(partial: Partial<SubscriptionAccountEntity> = {}): SubscriptionAccountEntity {
  return {
    account_id: "sacc-1", group_id: "g", provider: "codex", display_name: "a", account_label: "",
    enabled: true, status: "active", access_token: "x", refresh_token: "y",
    token_expires_at: NOW + 60 * MIN, provider_account_id: "p", usage: { windows: [] },
    usage_updated_at: null, exhausted_until: null, usage_fail_count: 0, refresh_fail_count: 0,
    last_error: null, active_sessions: 0, version: 1, created_at: "", updated_at: "",
    ...partial,
  };
}

function win(used_pct: number, resets_at: number | null): SubscriptionQuotaWindow {
  return { name: "primary_window", model_scope: null, used_pct, resets_at, observed_at: NOW, source: "usage_api" };
}

describe("planAccountTimers", () => {
  it("arms a refresh 10 minutes before the token expires", () => {
    expect(planAccountTimers(account(), 95, NOW)).toEqual([{ kind: "refresh", at: NOW + 50 * MIN }]);
  });

  it("arms an overdue refresh at once", () => {
    expect(planAccountTimers(account({ token_expires_at: NOW + MIN }), 95, NOW)).toEqual([{ kind: "refresh", at: NOW }]);
  });

  it("arms no refresh while a refresh retry owns the account or the expiry is unknown", () => {
    expect(planAccountTimers(account({ refresh_fail_count: 1 }), 95, NOW)).toEqual([]);
    expect(planAccountTimers(account({ token_expires_at: null }), 95, NOW)).toEqual([]);
  });

  it("arms nothing for a disabled account or one that needs a new login", () => {
    expect(planAccountTimers(account({ enabled: false, exhausted_until: NOW + MIN }), 95, NOW)).toEqual([]);
    expect(planAccountTimers(account({ status: "disabled" }), 95, NOW)).toEqual([]);
    expect(planAccountTimers(account({ status: "auth_error", exhausted_until: NOW + MIN }), 95, NOW)).toEqual([]);
  });

  it("checks an exhausted account 30 s after it is due to reset", () => {
    const plan = planAccountTimers(account({ status: "exhausted", exhausted_until: NOW + 20 * MIN, token_expires_at: null }), 95, NOW);
    expect(plan).toEqual([{ kind: "reset-check", at: NOW + 20 * MIN + 30_000 }]);
  });

  it("checks an exhaustion that a Core restart missed at once", () => {
    const plan = planAccountTimers(account({ status: "exhausted", exhausted_until: NOW - 60 * MIN, token_expires_at: null }), 95, NOW);
    expect(plan).toEqual([{ kind: "reset-check", at: NOW }]);
  });

  it("checks a near-limit account at the earliest reset of a window at or above the threshold", () => {
    const usage = { windows: [win(96, NOW + 40 * MIN), win(99, NOW + 20 * MIN), win(50, NOW + 5 * MIN), win(97, NOW - MIN)] };
    const plan = planAccountTimers(account({ usage, token_expires_at: null }), 95, NOW);
    expect(plan).toEqual([{ kind: "reset-check", at: NOW + 20 * MIN + 30_000 }]);
  });
});
