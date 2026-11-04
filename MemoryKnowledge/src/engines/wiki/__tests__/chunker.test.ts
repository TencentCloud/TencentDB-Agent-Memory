import { describe, expect, it } from "vitest";
import { chunkText, estimateTokens } from "../ingest-v2/chunker.js";

const section = (i: number) => `## Section ${i}\n\n${"内容".repeat(200)}`;

describe("chunkText", () => {
  it("returns [] for empty text and one chunk below the target", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("short text", { targetChars: 1000 })).toEqual(["short text"]);
  });

  it("splits long markdown by section boundaries and loses no section", () => {
    const text = Array.from({ length: 10 }, (_, i) => section(i)).join("\n\n");

    const chunks = chunkText(text, { targetChars: 1000, overlapChars: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
    const joined = chunks.join("\n\n");
    for (let i = 0; i < 10; i++) expect(joined).toContain(`## Section ${i}`);
  });

  it("carries an overlap tail into the next chunk", () => {
    const text = Array.from({ length: 10 }, (_, i) => section(i)).join("\n\n");

    const chunks = chunkText(text, { targetChars: 1000, overlapChars: 100 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].startsWith(chunks[0].slice(-100))).toBe(true);
  });

  it("hard-splits a single oversized paragraph", () => {
    const chunks = chunkText("a".repeat(2500), { targetChars: 1000, overlapChars: 0 });

    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunks.join("")).toBe("a".repeat(2500));
  });
});

describe("estimateTokens", () => {
  it("estimates conservatively at len/3", () => {
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});