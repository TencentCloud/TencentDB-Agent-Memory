import { describe, expect, it } from "vitest";
import { accountUsagePct, earliestReset, selectAccount } from "../selector.js";
import type { PoolAccount, PoolQuotaWindow } from "../types.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function win(name: string, used: number, resetsIn: number | null, scope: string | null = null): PoolQuotaWindow {
  return {
    name, model_scope: scope, used_pct: used,
    resets_at: resetsIn === null ? null : NOW + resetsIn, observed_at: NOW - 1000, source: "header",
  };
}

function acct(id: string, partial: Partial<PoolAccount> = {}, windows: PoolQuotaWindow[] = []): PoolAccount {
  return {
    account_id: id, group_id: "g", provider: "codex", provider_account_id: `pa-${id}`,
    status: "active", enabled: true, access_token: "tok", token_expires_at: NOW + 10 * HOUR,
    usage: { windows }, exhausted_until: null, ...partial,
  };
}

describe("selectAccount", () => {
  it("keeps the bound account while it is eligible", () => {
    const accounts = [acct("a"), acct("b")];
    const sel = selectAccount(accounts, "b", NOW, 95, "gpt-5", 0);
    expect(sel?.account.account_id).toBe("b");
    expect(sel?.kind).toBe("bound");
  });

  it("keeps a bound session on its account above the threshold until the quota is reached", () => {
    const accounts = [acct("a", {}, [win("primary_window", 97, HOUR)]), acct("b")];
    const sel = selectAccount(accounts, "a", NOW, 95, "gpt-5", 0);
    expect(sel?.account.account_id).toBe("a");
    expect(sel?.kind).toBe("bound");
  });

  it("moves a bound session when a window of its account reaches 100 %", () => {
    const accounts = [acct("a", {}, [win("primary_window", 100, HOUR)]), acct("b")];
    expect(selectAccount(accounts, "a", NOW, 95, "gpt-5", 0)?.account.account_id).toBe("b");
  });

  it("moves a bound session when its account is exhausted", () => {
    const accounts = [acct("a", { status: "exhausted", exhausted_until: NOW + HOUR }), acct("b")];
    expect(selectAccount(accounts, "a", NOW, 95, "gpt-5", 0)?.account.account_id).toBe("b");
  });

  it("moves to the next account by round-robin when there is no binding", () => {
    const accounts = [acct("a"), acct("b"), acct("c")];
    const first = selectAccount(accounts, null, NOW, 95, "gpt-5", 0)!;
    expect(first.account.account_id).toBe("a");
    const second = selectAccount(accounts, null, NOW, 95, "gpt-5", first.nextCursor)!;
    expect(second.account.account_id).toBe("b");
    const third = selectAccount(accounts, null, NOW, 95, "gpt-5", second.nextCursor)!;
    expect(third.account.account_id).toBe("c");
    const wrap = selectAccount(accounts, null, NOW, 95, "gpt-5", third.nextCursor)!;
    expect(wrap.account.account_id).toBe("a");
  });

  it("is independent of the input order", () => {
    const sel = selectAccount([acct("c"), acct("a"), acct("b")], null, NOW, 95, "m", 1)!;
    expect(sel.account.account_id).toBe("b");
  });

  it("skips disabled, auth_error and disabled-status accounts", () => {
    const accounts = [
      acct("a", { enabled: false }), acct("b", { status: "auth_error" }),
      acct("c", { status: "disabled" }), acct("d"),
    ];
    expect(selectAccount(accounts, null, NOW, 95, "m", 0)?.account.account_id).toBe("d");
  });

  it("skips an account while exhausted_until is in the future", () => {
    const accounts = [acct("a", { status: "exhausted", exhausted_until: NOW + HOUR }), acct("b")];
    expect(selectAccount(accounts, "a", NOW, 95, "m", 0)?.account.account_id).toBe("b");
  });

  it("releases an exhausted account once exhausted_until has passed", () => {
    const accounts = [acct("a", { status: "exhausted", exhausted_until: NOW - 1 })];
    const sel = selectAccount(accounts, null, NOW, 95, "m", 0);
    expect(sel?.account.account_id).toBe("a");
    expect(sel?.kind).toBe("round_robin");
  });

  it("treats a window past its reset time as reset", () => {
    const accounts = [acct("a", {}, [win("primary_window", 100, -1000), win("secondary_window", 10, HOUR)])];
    expect(selectAccount(accounts, null, NOW, 95, "m", 0)?.kind).toBe("round_robin");
  });

  it("skips an account when a shared window is at the threshold", () => {
    const accounts = [acct("a", {}, [win("primary_window", 95, HOUR)]), acct("b", {}, [win("primary_window", 94.9, HOUR)])];
    expect(selectAccount(accounts, null, NOW, 95, "m", 0)?.account.account_id).toBe("b");
  });

  it("checks the window of the requested model and ignores other models", () => {
    const accounts = [
      acct("a", {}, [win("weekly", 99, HOUR, "opus")]),
      acct("b", {}, [win("weekly", 99, HOUR, "other-model")]),
    ];
    expect(selectAccount(accounts, null, NOW, 95, "opus", 0)?.account.account_id).toBe("b");
    expect(selectAccount(accounts, null, NOW, 95, "plain", 0)?.account.account_id).toBe("a");
  });

  it("falls back to the lowest-usage account that is not exhausted, above the threshold", () => {
    const accounts = [
      acct("a", {}, [win("primary_window", 99, HOUR)]),
      acct("b", {}, [win("primary_window", 96, HOUR)]),
      acct("c", { status: "exhausted", exhausted_until: NOW + HOUR }, [win("primary_window", 100, HOUR)]),
    ];
    const sel = selectAccount(accounts, null, NOW, 95, "m", 0)!;
    expect(sel.account.account_id).toBe("b");
    expect(sel.kind).toBe("lowest_usage");
  });

  it("returns null when every account is exhausted or unusable", () => {
    const accounts = [
      acct("a", { status: "exhausted", exhausted_until: NOW + HOUR }),
      acct("b", { status: "auth_error" }),
    ];
    expect(selectAccount(accounts, null, NOW, 95, "m", 0)).toBeNull();
  });

  it("returns null for an empty pool", () => {
    expect(selectAccount([], null, NOW, 95, "m", 0)).toBeNull();
  });

  it("does not pick an excluded account", () => {
    const accounts = [acct("a"), acct("b")];
    expect(selectAccount(accounts, "a", NOW, 95, "m", 0, new Set(["a"]))?.account.account_id).toBe("b");
  });

  it("does not mutate the input array", () => {
    const accounts = [acct("b"), acct("a")];
    selectAccount(accounts, null, NOW, 95, "m", 0);
    expect(accounts.map((a) => a.account_id)).toEqual(["b", "a"]);
  });
});

describe("accountUsagePct", () => {
  it("is the maximum over the applicable windows", () => {
    const a = acct("a", {}, [win("p", 30, HOUR), win("s", 60, HOUR), win("m", 90, HOUR, "opus")]);
    expect(accountUsagePct(a, NOW, "plain")).toBe(60);
    expect(accountUsagePct(a, NOW, "opus")).toBe(90);
  });
});

describe("earliestReset", () => {
  it("uses exhausted_until of exhausted accounts and window resets of near-limit accounts", () => {
    const accounts = [
      acct("a", { status: "exhausted", exhausted_until: NOW + 3 * HOUR }),
      acct("b", {}, [win("primary_window", 97, 2 * HOUR), win("secondary_window", 99, 50 * HOUR)]),
    ];
    expect(earliestReset(accounts, NOW, 95, "m")).toBe(NOW + 2 * HOUR);
  });

  it("returns null when no reset time is known", () => {
    expect(earliestReset([acct("a", { status: "auth_error" })], NOW, 95, "m")).toBeNull();
  });
});
