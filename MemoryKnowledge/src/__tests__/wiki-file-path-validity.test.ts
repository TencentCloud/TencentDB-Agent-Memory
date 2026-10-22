import { describe, expect, it } from "vitest";
import { normalizeWikiPath } from "../engines/wiki/ingest-v2/file-protocol.js";

describe("Wiki FILE path portability", () => {
  it("keeps normal Unicode and Markdown paths valid", () => {
    expect(normalizeWikiPath("wiki/entities/Redis-主从.md")).toBe("wiki/entities/Redis-主从.md");
    expect(normalizeWikiPath("wiki/concepts/🚀 部署.md")).toBe("wiki/concepts/🚀 部署.md");
  });

  it.each([
    "wiki/entities/Redis\0.md",
    "wiki/entities/Redis\nname.md",
    "wiki/entities/Redis<bad>.md",
    "wiki/entities/Redis:bad.md",
    "wiki/entities/Redis|bad.md",
    "wiki/entities/Redis?bad.md",
    "wiki/entities/Redis*bad.md",
    "wiki/entities /Redis.md",
    "wiki/entities/CON.md",
    "wiki/entities/LPT1.cache.md",
  ])("rejects non-portable path %j", (path) => {
    expect(normalizeWikiPath(path)).toBeNull();
  });

  it("rejects path segments that exceed the portable UTF-8 byte budget", () => {
    expect(normalizeWikiPath(`wiki/entities/${"a".repeat(237)}.md`))
      .toBe(`wiki/entities/${"a".repeat(237)}.md`);
    expect(normalizeWikiPath(`wiki/entities/${"a".repeat(238)}.md`)).toBeNull();
    expect(normalizeWikiPath(`wiki/entities/${"中".repeat(80)}.md`)).toBeNull();
  });
});
