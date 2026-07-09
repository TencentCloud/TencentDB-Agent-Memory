import { describe, expect, it } from "vitest";
import { isSafeRefPath, sliceRefContent } from "./index.js";

describe("sliceRefContent", () => {
  it("returns the query hit from an oversized single-line ref payload", () => {
    const before = Array.from({ length: 400 }, (_, i) => `TDAI_OFFLOAD_SENTINEL ${i} ${"X".repeat(80)}`).join("\\n");
    const hit = `TDAI_OFFLOAD_SENTINEL 400 ${"X".repeat(80)}`;
    const after = Array.from({ length: 49 }, (_, i) => `TDAI_OFFLOAD_SENTINEL ${401 + i} ${"X".repeat(80)}`).join("\\n");
    const raw = `# Tool Result\n\n~~~json\n{"aggregated":"${before}\\n${hit}\\n${after}"}\n~~~`;

    const sliced = sliceRefContent(raw, {
      query: "TDAI_OFFLOAD_SENTINEL 400",
      maxTokens: 1200,
    });

    expect(sliced).toContain("TDAI_OFFLOAD_SENTINEL 400");
    expect(sliced).not.toBe("[truncated: max_tokens=1200]");
  });
});

describe("isSafeRefPath", () => {
  it("accepts a single refs filename and rejects traversal", () => {
    expect(isSafeRefPath("refs/tool-result.md")).toBe(true);
    expect(isSafeRefPath("refs/../secret.md")).toBe(false);
    expect(isSafeRefPath("refs/nested/result.md")).toBe(false);
    expect(isSafeRefPath("C:\\secret.md")).toBe(false);
  });
});
