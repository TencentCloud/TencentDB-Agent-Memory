import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";

describe("headless agent defaults", () => {
  it("allows missing task and enables bounded automatic conversations", () => {
    expect(DEFAULT_CONFIG.sessionInit.taskMissingPolicy).toBe("skip");
    expect(DEFAULT_CONFIG.sessionInit.headerAutoSelect?.onMismatch).toBe("bypass");
    expect(DEFAULT_CONFIG.autoConversationId).toEqual({
      enabled: true,
      ttlMinutes: 30,
      strategy: "per-key",
      maxEntries: 10_000,
    });
  });
});
