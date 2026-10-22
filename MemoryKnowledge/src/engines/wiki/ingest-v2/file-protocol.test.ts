import { describe, expect, it } from "vitest";
import { parseFileBlocks } from "./file-protocol.js";

describe("parseFileBlocks duplicate paths", () => {
  it("warns and keeps the last block when normalized paths collide", () => {
    const output = [
      '<<<FILE path="wiki/guide.md">>>',
      "first",
      "<<<END>>>",
      '<<<FILE path="wiki//guide.md">>>',
      "second",
      "<<<END>>>",
    ].join("\n");

    const result = parseFileBlocks(output);

    expect(result.files).toEqual([
      { path: "wiki/guide.md", content: "second\n" },
    ]);
    expect(result.warnings).toEqual([
      '重复 FILE path，后块覆盖前块: "wiki/guide.md"',
    ]);
  });

  it("drops an unclosed block instead of swallowing the next FILE opening", () => {
    const output = [
      '<<<FILE path="wiki/truncated.md">>>',
      "truncated content",
      '<<<FILE path="wiki/valid.md">>>',
      "valid content",
      "<<<END>>>",
    ].join("\n");

    const result = parseFileBlocks(output);

    expect(result.files).toEqual([
      { path: "wiki/valid.md", content: "valid content\n" },
    ]);
    expect(result.warnings).toEqual([
      '未闭合的 FILE 块，已丢弃: path="wiki/truncated.md"',
    ]);
  });
});
