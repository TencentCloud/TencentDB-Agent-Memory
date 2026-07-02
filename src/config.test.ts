import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("parseConfig recall options", () => {
  it("defaults injected recall to ephemeral and disables optional guards", () => {
    const cfg = parseConfig({});

    expect(cfg.recall.showInjected).toBe(false);
    expect(cfg.recall.dedupeInjected).toBe(false);
    expect(cfg.recall.dedupeMode).toBe("off");
    expect(cfg.recall.dedupeInjectedTtlTurns).toBe(0);
    expect(cfg.recall.maxReminderChars).toBe(600);
    expect(cfg.recall.maxCharsPerMemory).toBe(0);
    expect(cfg.recall.maxTotalRecallChars).toBe(0);
  });

  it("parses explicit showInjected, dedupe, and budget options", () => {
    const cfg = parseConfig({
      recall: {
        showInjected: true,
        dedupeInjected: true,
        dedupeMode: "reminder",
        dedupeInjectedTtlTurns: 4,
        maxReminderChars: 300,
        maxCharsPerMemory: 300,
        maxTotalRecallChars: 1200,
      },
    });

    expect(cfg.recall.showInjected).toBe(true);
    expect(cfg.recall.dedupeInjected).toBe(true);
    expect(cfg.recall.dedupeMode).toBe("reminder");
    expect(cfg.recall.dedupeInjectedTtlTurns).toBe(4);
    expect(cfg.recall.maxReminderChars).toBe(300);
    expect(cfg.recall.maxCharsPerMemory).toBe(300);
    expect(cfg.recall.maxTotalRecallChars).toBe(1200);
  });

  it("maps legacy dedupeInjected=true to skip mode when dedupeMode is unset", () => {
    const cfg = parseConfig({ recall: { dedupeInjected: true } });

    expect(cfg.recall.dedupeMode).toBe("skip");
  });
});
