import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initTimeModule,
  getActiveTimeZone,
  nowInstantISO,
  formatLocalDate,
  formatLocalDateTime,
  formatForLLM,
  describeTimeZoneForPrompt,
  startOfLocalDay,
  _resetTimeModuleForTest,
} from "./time.js";

describe("time module", () => {
  afterEach(() => {
    _resetTimeModuleForTest();
  });

  // ============================
  // resolveTimeZone / initTimeModule
  // ============================

  describe("initTimeModule / resolveTimeZone", () => {
    it("defaults to system timezone when no config", () => {
      initTimeModule({});
      const tz = getActiveTimeZone();
      // Should be a valid IANA timezone from the system
      expect(tz).toBeTruthy();
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz })).not.toThrow();
    });

    it('resolves "system" to process timezone', () => {
      initTimeModule({ timezone: "system" });
      const tz = getActiveTimeZone();
      const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      expect(tz).toBe(systemTz);
    });

    it("accepts valid IANA timezone names", () => {
      initTimeModule({ timezone: "Asia/Shanghai" });
      expect(getActiveTimeZone()).toBe("Asia/Shanghai");
    });

    it("accepts Europe/London (DST-aware timezone)", () => {
      initTimeModule({ timezone: "Europe/London" });
      expect(getActiveTimeZone()).toBe("Europe/London");
    });

    it("accepts America/New_York", () => {
      initTimeModule({ timezone: "America/New_York" });
      expect(getActiveTimeZone()).toBe("America/New_York");
    });

    it("accepts UTC", () => {
      initTimeModule({ timezone: "UTC" });
      expect(getActiveTimeZone()).toBe("UTC");
    });

    it("accepts UTC offset string +08:00", () => {
      initTimeModule({ timezone: "+08:00" });
      expect(getActiveTimeZone()).toBe("+08:00");
    });

    it("accepts UTC offset string -05:00", () => {
      initTimeModule({ timezone: "-05:00" });
      expect(getActiveTimeZone()).toBe("-05:00");
    });

    it("accepts half-hour offset +05:30 (India)", () => {
      initTimeModule({ timezone: "+05:30" });
      expect(getActiveTimeZone()).toBe("+05:30");
    });

    it("accepts +09:30 (Australia/Darwin equivalent)", () => {
      initTimeModule({ timezone: "+09:30" });
      expect(getActiveTimeZone()).toBe("+09:30");
    });

    it("accepts +00:00", () => {
      initTimeModule({ timezone: "+00:00" });
      expect(getActiveTimeZone()).toBe("+00:00");
    });

    it("falls back to system timezone for invalid string", () => {
      const warnings: string[] = [];
      initTimeModule({ timezone: "Invalid/FakeZone" }, { warn: (msg) => warnings.push(msg) });
      const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      expect(getActiveTimeZone()).toBe(systemTz);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("Invalid timezone");
    });

    it("falls back to system timezone for empty string", () => {
      initTimeModule({ timezone: "" });
      const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      expect(getActiveTimeZone()).toBe(systemTz);
    });

    it("falls back for garbage input", () => {
      const warnings: string[] = [];
      initTimeModule({ timezone: "!!garbage!!" }, { warn: (msg) => warnings.push(msg) });
      expect(warnings.length).toBe(1);
    });
  });

  // ============================
  // _resetTimeModuleForTest
  // ============================

  describe("_resetTimeModuleForTest", () => {
    it("resets timezone back to UTC", () => {
      initTimeModule({ timezone: "Asia/Tokyo" });
      expect(getActiveTimeZone()).toBe("Asia/Tokyo");
      _resetTimeModuleForTest();
      expect(getActiveTimeZone()).toBe("UTC");
    });
  });

  // ============================
  // A-type: nowInstantISO
  // ============================

  describe("nowInstantISO", () => {
    it("returns ISO 8601 string with Z suffix", () => {
      const result = nowInstantISO();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("is not affected by timezone configuration", () => {
      initTimeModule({ timezone: "Asia/Shanghai" });
      const t1 = nowInstantISO();
      _resetTimeModuleForTest();
      initTimeModule({ timezone: "America/New_York" });
      const t2 = nowInstantISO();
      // Both should be valid UTC and close in time
      const d1 = new Date(t1).getTime();
      const d2 = new Date(t2).getTime();
      expect(Math.abs(d1 - d2)).toBeLessThan(1000);
    });
  });

  // ============================
  // B-type: formatLocalDate
  // ============================

  describe("formatLocalDate", () => {
    it("formats as YYYY-MM-DD in configured timezone", () => {
      initTimeModule({ timezone: "Asia/Shanghai" });
      // 2026-06-01T20:00:00Z = 2026-06-02 04:00 in CST
      const d = new Date("2026-06-01T20:00:00Z");
      expect(formatLocalDate(d)).toBe("2026-06-02");
    });

    it("respects timezone — same instant, different local date", () => {
      // 2026-01-01T03:00:00Z
      // In UTC: Jan 1
      // In Asia/Shanghai (+8): Jan 1 11:00 → Jan 1
      // In America/New_York (-5): Dec 31 22:00 → Dec 31
      const d = new Date("2026-01-01T03:00:00Z");

      initTimeModule({ timezone: "UTC" });
      expect(formatLocalDate(d)).toBe("2026-01-01");

      _resetTimeModuleForTest();
      initTimeModule({ timezone: "Asia/Shanghai" });
      expect(formatLocalDate(d)).toBe("2026-01-01");

      _resetTimeModuleForTest();
      initTimeModule({ timezone: "America/New_York" });
      expect(formatLocalDate(d)).toBe("2025-12-31");
    });

    it("handles DST transition (Europe/London BST)", () => {
      initTimeModule({ timezone: "Europe/London" });
      // 2026-03-29 is the BST switch day (clocks go forward at 01:00)
      // 2026-03-29T00:30:00Z = 00:30 GMT (before switch) → Mar 29
      const beforeSwitch = new Date("2026-03-29T00:30:00Z");
      expect(formatLocalDate(beforeSwitch)).toBe("2026-03-29");

      // 2026-03-29T01:30:00Z = 02:30 BST (after switch) → still Mar 29
      const afterSwitch = new Date("2026-03-29T01:30:00Z");
      expect(formatLocalDate(afterSwitch)).toBe("2026-03-29");
    });

    it("uses offset string +05:30 correctly", () => {
      initTimeModule({ timezone: "+05:30" });
      // 2026-01-01T18:30:00Z = 2026-01-02 00:00 in +05:30
      const d = new Date("2026-01-01T18:30:00Z");
      expect(formatLocalDate(d)).toBe("2026-01-02");
    });
  });

  // ============================
  // B-type: formatLocalDateTime
  // ============================

  describe("formatLocalDateTime", () => {
    it("formats as YYYY-MM-DD HH:mm:ss", () => {
      initTimeModule({ timezone: "Asia/Shanghai" });
      const d = new Date("2026-03-15T06:30:45Z"); // 14:30:45 in CST
      expect(formatLocalDateTime(d)).toBe("2026-03-15 14:30:45");
    });

    it("handles midnight correctly", () => {
      initTimeModule({ timezone: "UTC" });
      const d = new Date("2026-06-01T00:00:00Z");
      expect(formatLocalDateTime(d)).toBe("2026-06-01 00:00:00");
    });

    it("handles end of day", () => {
      initTimeModule({ timezone: "UTC" });
      const d = new Date("2026-06-01T23:59:59Z");
      expect(formatLocalDateTime(d)).toBe("2026-06-01 23:59:59");
    });
  });

  // ============================
  // B-type: startOfLocalDay
  // ============================

  describe("startOfLocalDay", () => {
    it("returns midnight UTC ms for configured timezone", () => {
      initTimeModule({ timezone: "Asia/Shanghai" });
      // For 2026-06-02 in CST, midnight = 2026-06-01T16:00:00Z
      const d = new Date("2026-06-02T04:00:00Z"); // 12:00 CST on Jun 2
      const start = startOfLocalDay(d);
      // Midnight CST Jun 2 = UTC Jun 1 16:00
      expect(start).toBe(new Date("2026-06-01T16:00:00Z").getTime());
    });

    it("works for UTC", () => {
      initTimeModule({ timezone: "UTC" });
      const d = new Date("2026-03-15T10:30:00Z");
      const start = startOfLocalDay(d);
      expect(start).toBe(new Date("2026-03-15T00:00:00Z").getTime());
    });

    it("works for negative offset timezone", () => {
      initTimeModule({ timezone: "America/New_York" });
      // In winter (EST = UTC-5), midnight EST = 05:00 UTC
      const d = new Date("2026-01-15T10:00:00Z"); // 05:00 EST
      const start = startOfLocalDay(d);
      expect(start).toBe(new Date("2026-01-15T05:00:00Z").getTime());
    });
  });

  // ============================
  // C-type: formatForLLM
  // ============================

  describe("formatForLLM", () => {
    it("formats Date with timezone offset", () => {
      initTimeModule({ timezone: "Asia/Shanghai" });
      const d = new Date("2026-04-07T03:04:45Z"); // 11:04:45+08:00
      const result = formatForLLM(d);
      expect(result).toBe("2026-04-07T11:04:45+08:00");
    });

    it("formats ISO string input (Z suffix)", () => {
      initTimeModule({ timezone: "Asia/Shanghai" });
      const result = formatForLLM("2026-04-07T03:04:45.000Z");
      expect(result).toBe("2026-04-07T11:04:45+08:00");
    });

    it("formats Unix millisecond timestamp", () => {
      initTimeModule({ timezone: "UTC" });
      const ms = new Date("2026-06-01T12:00:00Z").getTime();
      const result = formatForLLM(ms);
      expect(result).toBe("2026-06-01T12:00:00+00:00");
    });

    it("handles negative offset (America/New_York winter)", () => {
      initTimeModule({ timezone: "America/New_York" });
      // 2026-01-15T17:30:00Z = 12:30:00 EST (-05:00)
      const result = formatForLLM("2026-01-15T17:30:00Z");
      expect(result).toBe("2026-01-15T12:30:00-05:00");
    });

    it("handles DST (America/New_York summer)", () => {
      initTimeModule({ timezone: "America/New_York" });
      // 2026-07-15T17:30:00Z = 13:30:00 EDT (-04:00)
      const result = formatForLLM("2026-07-15T17:30:00Z");
      expect(result).toBe("2026-07-15T13:30:00-04:00");
    });

    it("handles half-hour offset +05:30", () => {
      initTimeModule({ timezone: "+05:30" });
      // 2026-01-01T00:00:00Z = 05:30 in +05:30
      const result = formatForLLM("2026-01-01T00:00:00Z");
      expect(result).toBe("2026-01-01T05:30:00+05:30");
    });

    it("passes through invalid/unparseable input", () => {
      initTimeModule({ timezone: "UTC" });
      expect(formatForLLM("not-a-date")).toBe("not-a-date");
    });

    it("handles old UTC data correctly (backward compat)", () => {
      initTimeModule({ timezone: "Europe/Berlin" });
      // 2025-12-15T22:00:00.000Z — old data stored as UTC
      // Berlin in winter = CET = UTC+1, so 23:00:00+01:00
      const result = formatForLLM("2025-12-15T22:00:00.000Z");
      expect(result).toBe("2025-12-15T23:00:00+01:00");
    });
  });

  // ============================
  // C-type: describeTimeZoneForPrompt
  // ============================

  describe("describeTimeZoneForPrompt", () => {
    it("includes timezone name and offset", () => {
      initTimeModule({ timezone: "Asia/Shanghai" });
      const desc = describeTimeZoneForPrompt();
      expect(desc).toContain("Asia/Shanghai");
      expect(desc).toContain("+08:00");
      expect(desc).toContain("timestamps");
    });

    it("includes timezone for UTC", () => {
      initTimeModule({ timezone: "UTC" });
      const desc = describeTimeZoneForPrompt();
      expect(desc).toContain("UTC");
      expect(desc).toContain("+00:00");
    });

    it("works with offset string config", () => {
      initTimeModule({ timezone: "+05:30" });
      const desc = describeTimeZoneForPrompt();
      expect(desc).toContain("+05:30");
    });
  });
});
