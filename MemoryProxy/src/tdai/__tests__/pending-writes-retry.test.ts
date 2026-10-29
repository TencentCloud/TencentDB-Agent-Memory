import { describe, expect, it } from "vitest";
import { withL0Retry } from "../pending-writes.js";

describe("withL0Retry HTTP 409 classification", () => {
  it("retries an explicit concurrent-write conflict", async () => {
    let calls = 0;

    const result = await withL0Retry(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(
          "tdai POST /v3/conversation/add HTTP 409: Concurrent write conflict, please retry",
        );
      }
      return "stored";
    }, { baseMs: 0 });

    expect(result).toBe("stored");
    expect(calls).toBe(2);
  });

  it("does not retry a deterministic version conflict", async () => {
    let calls = 0;

    await expect(withL0Retry(async () => {
      calls += 1;
      throw new Error("tdai POST /v3/conversation/add HTTP 409: SKILL_VERSION_STALE");
    }, { baseMs: 0 })).rejects.toThrow("SKILL_VERSION_STALE");

    expect(calls).toBe(1);
  });
});
