import { afterEach, describe, expect, it, vi } from "vitest";

import { deferredTimerType, isLlmWindowOpen, nextLlmWindowOpenMs } from "./llm-window.js";

// 2026-09-14 is a Monday; 09-19 a Saturday, 09-20 a Sunday (local time).
const MONDAY = { y: 2026, m: 8, d: 14 };
const SATURDAY = { y: 2026, m: 8, d: 19 };
const SUNDAY = { y: 2026, m: 8, d: 20 };

function at(day: { y: number; m: number; d: number }, hour: number, minute = 0): Date {
  return new Date(day.y, day.m, day.d, hour, minute, 0, 0);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isLlmWindowOpen", () => {
  it("never closes the window when the gate is off", () => {
    expect(isLlmWindowOpen(at(MONDAY, 10))).toBe(true);
    expect(isLlmWindowOpen(at(MONDAY, 14))).toBe(true);
  });

  it("treats any value other than 'on' as disabled", () => {
    vi.stubEnv("TDAI_LLM_WINDOW", "off");
    expect(isLlmWindowOpen(at(MONDAY, 10))).toBe(true);
  });

  describe("with TDAI_LLM_WINDOW=on", () => {
    it("closes on weekday 09:00-17:59", () => {
      vi.stubEnv("TDAI_LLM_WINDOW", "on");
      expect(isLlmWindowOpen(at(MONDAY, 9))).toBe(false);
      expect(isLlmWindowOpen(at(MONDAY, 12))).toBe(false);
      expect(isLlmWindowOpen(at(MONDAY, 17, 59))).toBe(false);
    });

    it("stays open on weekday evenings and early mornings", () => {
      vi.stubEnv("TDAI_LLM_WINDOW", "on");
      expect(isLlmWindowOpen(at(MONDAY, 18))).toBe(true);
      expect(isLlmWindowOpen(at(MONDAY, 23))).toBe(true);
      expect(isLlmWindowOpen(at(MONDAY, 8, 59))).toBe(true);
      expect(isLlmWindowOpen(at(MONDAY, 0))).toBe(true);
    });

    it("always stays open on weekends", () => {
      vi.stubEnv("TDAI_LLM_WINDOW", "on");
      expect(isLlmWindowOpen(at(SATURDAY, 10))).toBe(true);
      expect(isLlmWindowOpen(at(SUNDAY, 14))).toBe(true);
    });

    it("honours a custom TDAI_LLM_WINDOW_HOURS range", () => {
      vi.stubEnv("TDAI_LLM_WINDOW", "on");
      vi.stubEnv("TDAI_LLM_WINDOW_HOURS", "22-23");
      expect(isLlmWindowOpen(at(MONDAY, 22, 30))).toBe(false);
      expect(isLlmWindowOpen(at(MONDAY, 10))).toBe(true);
    });

    it("falls back to 9-18 on a malformed TDAI_LLM_WINDOW_HOURS", () => {
      vi.stubEnv("TDAI_LLM_WINDOW", "on");
      vi.stubEnv("TDAI_LLM_WINDOW_HOURS", "not-a-range");
      expect(isLlmWindowOpen(at(MONDAY, 10))).toBe(false);
      expect(isLlmWindowOpen(at(MONDAY, 18))).toBe(true);
    });
  });
});

describe("nextLlmWindowOpenMs", () => {
  it("returns the current instant when the window is open", () => {
    const now = at(MONDAY, 20);
    expect(nextLlmWindowOpenMs(now)).toBe(now.getTime());
  });

  it("returns the same day's closing hour when the window is closed", () => {
    vi.stubEnv("TDAI_LLM_WINDOW", "on");
    expect(nextLlmWindowOpenMs(at(MONDAY, 10))).toBe(at(MONDAY, 18).getTime());
  });

  it("uses the custom range's end hour", () => {
    vi.stubEnv("TDAI_LLM_WINDOW", "on");
    vi.stubEnv("TDAI_LLM_WINDOW_HOURS", "13-15");
    expect(nextLlmWindowOpenMs(at(MONDAY, 14))).toBe(at(MONDAY, 15).getTime());
  });
});

describe("deferredTimerType", () => {
  it("maps LLM task types onto the suffixes the scheduler already routes", () => {
    expect(deferredTimerType("L1")).toBe("L1_idle");
    expect(deferredTimerType("flush")).toBe("L1_idle");
    expect(deferredTimerType("L2")).toBe("L2_schedule");
    expect(deferredTimerType("L3")).toBe("L3_deferred");
  });

  it("leaves non-LLM tasks alone", () => {
    expect(deferredTimerType("offload-l1")).toBeNull();
    expect(deferredTimerType("offload-l15")).toBeNull();
    expect(deferredTimerType("offload-l2")).toBeNull();
    expect(deferredTimerType("something-else")).toBeNull();
  });
});
