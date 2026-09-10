import { describe, expect, it } from "vitest";
import { captureCursorFloor } from "./capture-timing.js";

describe("captureCursorFloor", () => {
  it("places the cursor before the earliest explicit message timestamp", () => {
    expect(captureCursorFloor([
      { role: "assistant", timestamp: 2_000 },
      { role: "user", timestamp: 1_000 },
    ])).toBe(999);
  });

  it("leaves ordinary captures without explicit timestamps unchanged", () => {
    expect(captureCursorFloor([{ role: "user", content: "hello" }])).toBeUndefined();
    expect(captureCursorFloor(undefined)).toBeUndefined();
  });

  it("ignores invalid timestamp values", () => {
    expect(captureCursorFloor([
      { timestamp: -1 },
      { timestamp: 1.5 },
      { timestamp: "1000" },
    ])).toBeUndefined();
  });
});
