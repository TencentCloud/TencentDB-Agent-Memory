import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMemoryCleaner } from "./memory-cleaner.js";
import { _resetTimeModuleForTest, initTimeModule } from "./time.js";

afterEach(() => {
  vi.useRealTimers();
  _resetTimeModuleForTest();
});

describe("LocalMemoryCleaner", () => {
  it("schedules cleanTime in the configured timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T12:00:00.000Z"));
    initTimeModule({ timezone: "America/New_York" });

    const debugLogs: string[] = [];
    const cleaner = new LocalMemoryCleaner({
      baseDir: "/unused",
      retentionDays: 3,
      cleanTime: "03:00",
      logger: {
        debug: (msg) => debugLogs.push(msg),
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    cleaner.start();
    cleaner.destroy();

    const scheduleLog = debugLogs.find((msg) => msg.includes("Schedule next run"));
    expect(scheduleLog).toContain("nextRunIso=2026-07-01T07:00:00.000Z");
    expect(scheduleLog).toContain("nextRunLocal=2026-07-01 03:00:00");
  });
});
