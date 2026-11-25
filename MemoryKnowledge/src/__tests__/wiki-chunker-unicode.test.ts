import { describe, expect, it } from "vitest";
import { chunkText } from "../engines/wiki/ingest-v2/chunker.js";

function utf8RoundTrips(value: string): boolean {
  return Buffer.from(value, "utf-8").toString("utf-8") === value;
}

describe("Wiki chunker Unicode boundaries", () => {
  it("does not hard-cut a surrogate pair", () => {
    const text = `${"a".repeat(999)}😀${"b".repeat(1_000)}`;
    const chunks = chunkText(text, { targetChars: 1_000, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(utf8RoundTrips)).toBe(true);
  });

  it("does not begin overlap with a low surrogate", () => {
    const unitA = `# A\n${"a".repeat(495)}😀${"b".repeat(499)}`;
    const unitB = `# B\n${"c".repeat(995)}`;
    const chunks = chunkText(`${unitA}\n${unitB}`, {
      targetChars: 1_000,
      overlapChars: 500,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(utf8RoundTrips)).toBe(true);
  });
});
