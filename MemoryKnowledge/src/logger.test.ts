/**
 * Regression test for https://github.com/TencentCloud/TencentDB-Agent-Memory/issues/1264 (gap 1)
 *
 * The Knowledge logger previously emitted UTC via `toISOString()` with no
 * timezone marker, while MemoryCore's gateway logger uses local time with an
 * explicit offset (nowLocalIso). Cross-service incident correlation required
 * mental +offset conversion with no in-band hint.
 *
 * The Knowledge logger now uses the same local-time ISO 8601 format.
 */
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger timestamp", () => {
  it("emits local time with an explicit UTC offset, not bare UTC", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      createLogger("test-tag").info("hello");
      expect(spy).toHaveBeenCalledOnce();
      const line = spy.mock.calls[0][0] as string;

      // ISO 8601 local time with offset, e.g. 2026-09-06T18:03:04.123+08:00
      // Bare UTC output (the old behavior) has no offset and a space separator.
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} /);
    } finally {
      spy.mockRestore();
    }
  });
});
