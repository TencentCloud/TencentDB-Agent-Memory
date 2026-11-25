import { describe, expect, it } from "vitest";
import { normalizeWikiPath, parseFileBlocks } from "../engines/wiki/ingest-v2/file-protocol.js";

describe("Wiki FILE block path extensions", () => {
  it("accepts Markdown paths in either case", () => {
    expect(normalizeWikiPath("wiki/entities/Redis.md")).toBe("wiki/entities/Redis.md");
    expect(normalizeWikiPath("wiki/entities/Redis.MD")).toBe("wiki/entities/Redis.MD");
  });

  it.each([
    "wiki/entities/Redis.txt",
    "wiki/entities/Redis.json",
    "wiki/entities/Redis",
    "wiki/entities/Redis.md.json",
  ])("rejects non-Markdown page path %s", (path) => {
    expect(normalizeWikiPath(path)).toBeNull();
  });

  it("skips a non-Markdown FILE block with a warning", () => {
    const output = [
      '<<<FILE path="wiki/entities/Redis.txt">>>',
      "invisible orphan",
      "<<<END>>>",
      '<<<FILE path="wiki/entities/Redis.md">>>',
      "visible page",
      "<<<END>>>",
    ].join("\n");

    const result = parseFileBlocks(output);

    expect(result.files).toEqual([{ path: "wiki/entities/Redis.md", content: "visible page\n" }]);
    expect(result.warnings).toEqual(['非法 path 已跳过: "wiki/entities/Redis.txt"']);
  });
});
