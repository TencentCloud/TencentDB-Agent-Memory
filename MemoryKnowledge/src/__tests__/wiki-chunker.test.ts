import { describe, expect, it } from "vitest";
import { chunkText } from "../engines/wiki/ingest-v2/chunker.js";

describe("Wiki source chunking", () => {
  it("keeps every output chunk within targetChars when overlap is configured", () => {
    const unitA = `# A\n${"a".repeat(995)}`;
    const unitB = `# B\n${"b".repeat(995)}`;
    const targetChars = 1_000;

    const chunks = chunkText(`${unitA}\n${unitB}`, {
      targetChars,
      overlapChars: 500,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= targetChars)).toBe(true);
    expect(chunks.at(-1)).toContain("bbbb");
  });
});
