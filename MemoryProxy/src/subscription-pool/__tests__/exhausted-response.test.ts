import { describe, expect, it } from "vitest";
import { buildPoolExhaustedResponse, UNKNOWN_RESET_RETRY_AFTER_SEC } from "../exhausted-response.js";

const NOW = 1_800_000_000_000;

describe("buildPoolExhaustedResponse", () => {
  it("answers 429 with retry-after, pool status and earliest reset (epoch seconds)", async () => {
    const res = buildPoolExhaustedResponse(NOW + 90_500, NOW);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("91");
    expect(res.headers.get("x-tdai-pool-status")).toBe("exhausted");
    expect(res.headers.get("x-tdai-pool-earliest-reset")).toBe(String(Math.ceil((NOW + 90_500) / 1000)));
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json() as { error: { type: string; message: string; resets_at?: number } };
    expect(body.error.type).toBe("usage_limit_reached");
    expect(body.error.resets_at).toBe(Math.ceil((NOW + 90_500) / 1000));
    expect(body.error.message.length).toBeGreaterThan(0);
  });

  it("uses a default retry-after and no reset header when no reset time is known", async () => {
    const res = buildPoolExhaustedResponse(null, NOW);
    expect(res.headers.get("retry-after")).toBe(String(UNKNOWN_RESET_RETRY_AFTER_SEC));
    expect(res.headers.get("x-tdai-pool-status")).toBe("exhausted");
    expect(res.headers.get("x-tdai-pool-earliest-reset")).toBeNull();
    const body = await res.json() as { error: { resets_at?: number } };
    expect(body.error.resets_at).toBeUndefined();
  });

  it("never returns a retry-after below one second", () => {
    expect(buildPoolExhaustedResponse(NOW + 10, NOW).headers.get("retry-after")).toBe("1");
  });
});
