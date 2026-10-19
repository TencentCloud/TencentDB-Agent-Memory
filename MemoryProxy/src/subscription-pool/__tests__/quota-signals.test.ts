import { describe, expect, it } from "vitest";
import { parseClaudeLimitBody, parseClaudeQuotaHeaders, parseCodexQuotaHeaders, parseCodexLimitBody } from "../quota-signals.js";

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

describe("parseCodexQuotaHeaders", () => {
  it("maps the primary and secondary headers to usage API window names, converting seconds to ms", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "42.5",
      "x-codex-primary-reset-at": String(NOW_S + 3600),
      "x-codex-secondary-primary-used-percent": "7",
      "x-codex-secondary-primary-reset-at": String(NOW_S + 86_400),
    });
    expect(parseCodexQuotaHeaders(headers, NOW_MS)).toEqual([
      { name: "primary_window", model_scope: null, used_pct: 42.5, resets_at: (NOW_S + 3600) * 1000, observed_at: NOW_MS, source: "header" },
      { name: "secondary_window", model_scope: null, used_pct: 7, resets_at: (NOW_S + 86_400) * 1000, observed_at: NOW_MS, source: "header" },
    ]);
  });

  it("reports a window without a reset header with resets_at null", () => {
    const windows = parseCodexQuotaHeaders(new Headers({ "x-codex-primary-used-percent": "10" }), NOW_MS);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.resets_at).toBeNull();
  });

  it("returns nothing when the headers are absent or not numbers", () => {
    expect(parseCodexQuotaHeaders(new Headers(), NOW_MS)).toEqual([]);
    expect(parseCodexQuotaHeaders(new Headers({ "x-codex-primary-used-percent": "abc" }), NOW_MS)).toEqual([]);
  });

  it("clamps the percentage into 0..100", () => {
    const windows = parseCodexQuotaHeaders(new Headers({ "x-codex-primary-used-percent": "130" }), NOW_MS);
    expect(windows[0]!.used_pct).toBe(100);
  });
});

describe("parseCodexLimitBody", () => {
  it("reads resets_at (epoch s) of a usage_limit_reached error into ms and a retry_after in seconds", () => {
    const body = JSON.stringify({ error: { type: "usage_limit_reached", resets_at: NOW_S + 600 } });
    expect(parseCodexLimitBody(body, new Headers(), NOW_MS)).toEqual({ resetsAt: (NOW_S + 600) * 1000, retryAfterSec: 600 });
  });

  it("falls back to the retry-after header", () => {
    expect(parseCodexLimitBody("{}", new Headers({ "retry-after": "120" }), NOW_MS)).toEqual({
      resetsAt: NOW_MS + 120_000, retryAfterSec: 120,
    });
  });

  it("reads resets_in_seconds when resets_at is missing", () => {
    const body = JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 90 } });
    expect(parseCodexLimitBody(body, new Headers(), NOW_MS)).toEqual({ resetsAt: NOW_MS + 90_000, retryAfterSec: 90 });
  });

  it("returns nulls for a body without a reset time or invalid JSON", () => {
    expect(parseCodexLimitBody("not json", new Headers(), NOW_MS)).toEqual({ resetsAt: null, retryAfterSec: null });
    expect(parseCodexLimitBody(JSON.stringify({ error: { type: "rate_limit_exceeded" } }), new Headers(), NOW_MS)).toEqual({
      resetsAt: null, retryAfterSec: null,
    });
  });

  it("ignores a reset time that is already in the past", () => {
    const body = JSON.stringify({ error: { resets_at: NOW_S - 10 } });
    expect(parseCodexLimitBody(body, new Headers(), NOW_MS)).toEqual({ resetsAt: null, retryAfterSec: null });
  });
});

describe("parseClaudeQuotaHeaders", () => {
  it("turns the 5h and 7d fractions into percents and epoch seconds into ms", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": String(NOW_S + 3600),
      "anthropic-ratelimit-unified-7d-utilization": "1.01",
      "anthropic-ratelimit-unified-7d-reset": String(NOW_S + 86_400),
    });
    expect(parseClaudeQuotaHeaders(headers, NOW_MS)).toEqual([
      { name: "five_hour", model_scope: null, used_pct: 42, resets_at: (NOW_S + 3600) * 1000, observed_at: NOW_MS, source: "header" },
      { name: "seven_day", model_scope: null, used_pct: 100, resets_at: (NOW_S + 86_400) * 1000, observed_at: NOW_MS, source: "header" },
    ]);
  });

  it("returns nothing when the utilization headers are absent", () => {
    expect(parseClaudeQuotaHeaders(new Headers(), NOW_MS)).toEqual([]);
  });
});

describe("parseClaudeLimitBody", () => {
  it("prefers the unified reset, then the 5h reset, then retry-after", () => {
    expect(parseClaudeLimitBody(new Headers({
      "anthropic-ratelimit-unified-reset": String(NOW_S + 600),
      "anthropic-ratelimit-unified-5h-reset": String(NOW_S + 60),
      "retry-after": "10",
    }), NOW_MS)).toEqual({ resetsAt: (NOW_S + 600) * 1000, retryAfterSec: 600 });

    expect(parseClaudeLimitBody(new Headers({
      "anthropic-ratelimit-unified-5h-reset": String(NOW_S + 120),
    }), NOW_MS).retryAfterSec).toBe(120);

    expect(parseClaudeLimitBody(new Headers({ "retry-after": "30" }), NOW_MS)).toEqual({
      resetsAt: NOW_MS + 30_000,
      retryAfterSec: 30,
    });
  });

  it("returns no reset when every header is missing or already past", () => {
    expect(parseClaudeLimitBody(new Headers(), NOW_MS)).toEqual({ resetsAt: null, retryAfterSec: null });
    expect(parseClaudeLimitBody(new Headers({
      "anthropic-ratelimit-unified-reset": String(NOW_S - 5),
    }), NOW_MS)).toEqual({ resetsAt: null, retryAfterSec: null });
  });
});
