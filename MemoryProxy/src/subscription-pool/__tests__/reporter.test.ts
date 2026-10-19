import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportAccount, resetReporterForTests, REPORT_INTERVAL_MS } from "../reporter.js";
import type { PoolQuotaWindow } from "../types.js";

const CORE = { endpoint: "http://core.test", serviceToken: "svc", timeoutMs: 1000 };

function win(name: string, used: number, resets = 1000): PoolQuotaWindow {
  return { name, model_scope: null, used_pct: used, resets_at: resets, observed_at: Date.now(), source: "header" };
}

function bodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
}

describe("pool reporter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    resetReporterForTests();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("sends the first report at once, to the report endpoint with account id and instance id", async () => {
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 10)] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://core.test/v3/internal/meta/subscription-pool/report");
    expect((init.headers as Record<string, string>)["x-tdai-service-id"]).toBe("sp1");
    expect(bodies(fetchMock)[0]).toMatchObject({ account_id: "acc-1", windows: [{ name: "primary_window", used_pct: 10 }] });
  });

  it("batches later changes of the same account into one report per interval", async () => {
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 10)] });
    await vi.advanceTimersByTimeAsync(0);
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 20)] });
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 30)], active_sessions: 3 });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS - 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies(fetchMock)[1]).toMatchObject({ account_id: "acc-1", active_sessions: 3, windows: [{ used_pct: 30 }] });
  });

  it("keeps accounts independent", async () => {
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 10)] });
    reportAccount(CORE, "sp1", "acc-2", { windows: [win("primary_window", 10)] });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips a window that changed by less than one percent since the last report", async () => {
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 10)] });
    await vi.advanceTimersByTimeAsync(0);
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 10.5)] });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS + 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 11)] });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS + 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("always reports a 429 with its retry_after, even when windows are unchanged", async () => {
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 100)] });
    await vi.advanceTimersByTimeAsync(0);
    reportAccount(CORE, "sp1", "acc-1", { status_code: 429, retry_after: 600, windows: [win("primary_window", 100)] });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS + 10);
    expect(bodies(fetchMock)[1]).toMatchObject({ status_code: 429, retry_after: 600 });
  });

  it("a 429 stays in the batch when a later report in the same interval has no status", async () => {
    reportAccount(CORE, "sp1", "acc-1", { active_sessions: 1 });
    await vi.advanceTimersByTimeAsync(0);
    reportAccount(CORE, "sp1", "acc-1", { status_code: 429, retry_after: 60 });
    reportAccount(CORE, "sp1", "acc-1", { active_sessions: 2 });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS + 10);
    expect(bodies(fetchMock)[1]).toMatchObject({ status_code: 429, retry_after: 60, active_sessions: 2 });
  });

  it("a 429 is not replaced by a 401 reported within the same interval", async () => {
    reportAccount(CORE, "sp1", "acc-1", { active_sessions: 1 });
    await vi.advanceTimersByTimeAsync(0);
    reportAccount(CORE, "sp1", "acc-1", { status_code: 429, retry_after: 600 });
    reportAccount(CORE, "sp1", "acc-1", { status_code: 401 });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS + 10);
    expect(bodies(fetchMock)[1]).toMatchObject({ status_code: 429, retry_after: 600 });
  });

  it("a later 429 replaces the retry_after of an earlier one", async () => {
    reportAccount(CORE, "sp1", "acc-1", { active_sessions: 1 });
    await vi.advanceTimersByTimeAsync(0);
    reportAccount(CORE, "sp1", "acc-1", { status_code: 429, retry_after: 600 });
    reportAccount(CORE, "sp1", "acc-1", { status_code: 429, retry_after: 300 });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS + 10);
    expect(bodies(fetchMock)[1]).toMatchObject({ status_code: 429, retry_after: 300 });
  });

  it("never throws or rejects when Core is down, and keeps the account id out of nothing but logs", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => reportAccount(CORE, "sp1", "acc-1", { status_code: 429 })).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("acc-1");
    warn.mockRestore();
  });

  it("sends a failed report again at the next interval instead of dropping it", async () => {
    fetchMock.mockRejectedValueOnce(new Error("core down"));
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 10)], active_sessions: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS + 10);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies(fetchMock)[1]).toMatchObject({ account_id: "acc-1", active_sessions: 2, windows: [{ name: "primary_window", used_pct: 10 }] });
  });

  it("keeps newer values over the failed ones when it sends again", async () => {
    fetchMock.mockRejectedValueOnce(new Error("core down"));
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 10)] });
    await vi.advanceTimersByTimeAsync(0);
    reportAccount(CORE, "sp1", "acc-1", { windows: [win("primary_window", 30)] });
    await vi.advanceTimersByTimeAsync(REPORT_INTERVAL_MS + 10);
    expect(bodies(fetchMock)[1]).toMatchObject({ windows: [{ name: "primary_window", used_pct: 30 }] });
  });

  it("does not send again a report that Core refused as a client error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 404, message: "account_not_found: gone" }), { status: 404 }));
    reportAccount(CORE, "sp1", "acc-gone", { active_sessions: 1 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3 * REPORT_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
