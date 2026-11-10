import { describe, expect, it } from "vitest";
import { reviewFiles } from "./skill-review.js";
describe("bounded package file reviews", () => {
  it("distinguishes added, deleted, unchanged and executable-only changes without leaking all text", () => {
    const before = {
      content: "body",
      resources: [
        { path: "run.sh", content: "echo ok", is_executable: false },
        { path: "old.md", content: "old" },
      ],
    };
    const after = {
      content: "body",
      resources: [
        { path: "run.sh", content: "echo ok", is_executable: true },
        { path: "new.md", content: "new" },
      ],
    };
    const files = reviewFiles(before, after);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["SKILL.md", "unchanged"],
      ["new.md", "added"],
      ["old.md", "removed"],
      ["run.sh", "changed"],
    ]);
    expect(files[0].after).not.toHaveProperty("text");
    expect(reviewFiles(before, after, "run.sh")[0]).toMatchObject({
      before: { text: "echo ok", executable: false },
      after: { text: "echo ok", executable: true },
    });
  });
  it("preserves CRLF and missing final newline and rejects paths outside the package", () => {
    const after = { content: "a\r\nb", resources: [] };
    expect(reviewFiles(null, after, "SKILL.md")[0]).toMatchObject({
      before: null,
      after: { text: "a\r\nb" },
      status: "added",
    });
    expect(() => reviewFiles(null, after, "../secret")).toThrow("not in");
  });
  it("returns honest summaries for binary, invalid UTF-8, oversized and many-line files", () => {
    const after = {
      content: "body",
      resources: [
        { path: "binary", content: "a\0b" },
        { path: "invalid", content: "/w==", encoding: "base64" as const },
        { path: "large", content: "x".repeat(100001) },
        { path: "lines", content: "x\n".repeat(2001) },
      ],
    };
    for (const [path, reason] of [
      ["binary", "binary"],
      ["invalid", "binary"],
      ["large", "large"],
      ["lines", "large"],
    ]) {
      const file = reviewFiles(null, after, path)[0];
      expect(file.after?.reason).toBe(reason);
      expect(file.after).not.toHaveProperty("text");
      expect(file.after?.hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
