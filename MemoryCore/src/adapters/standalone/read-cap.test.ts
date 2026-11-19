import { describe, expect, it } from "vitest";
import { capReadContent, DEFAULT_READ_MAX_BYTES } from "./read-cap.js";
import { createStorageTools } from "./storage-tools.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("capReadContent", () => {
  it("returns small content unchanged", () => {
    expect(capReadContent("hello", 100)).toBe("hello");
  });

  it("truncates content over the cap, stays within it, and says how much was left out", () => {
    const out = capReadContent("a".repeat(1000), 200);
    expect(out.startsWith("a".repeat(100))).toBe(true);
    expect(out).toMatch(/\[truncated: showing first \d+ of 1000 bytes\]$/);
    expect(bytes(out)).toBeLessThanOrEqual(200);
  });

  it("does not split a multi-byte character", () => {
    // "旧" is 3 bytes in UTF-8, so a byte cut can land inside a character.
    const out = capReadContent("旧".repeat(200), 150);
    expect(out).not.toContain("�");
    expect(out).toContain("of 600 bytes]");
    expect(bytes(out)).toBeLessThanOrEqual(150);
  });

  it("applies a default cap well below a 700 KB scene file", () => {
    const out = capReadContent("x".repeat(700 * 1024));
    expect(bytes(out)).toBeLessThanOrEqual(DEFAULT_READ_MAX_BYTES);
  });

  it("never returns more bytes than the cap, even one byte over it", () => {
    const out = capReadContent("a".repeat(DEFAULT_READ_MAX_BYTES + 1));
    expect(bytes(out)).toBeLessThanOrEqual(DEFAULT_READ_MAX_BYTES);
  });

  it("keeps a genuine U+FFFD that sits right before the cut", () => {
    const text = "a".repeat(100) + "�" + "b".repeat(500);
    // Budget leaves room for exactly the 100 a's plus the 3-byte U+FFFD.
    const out = capReadContent(text, 100 + 80 + 3);
    expect(out.startsWith("a".repeat(100) + "�")).toBe(true);
  });
});

describe("storage read tool", () => {
  it("caps a huge scene file instead of returning it verbatim", async () => {
    const big = "scene block\n".repeat(60_000); // ~720 KB
    const storage = { readFile: async () => big } as any;
    const tools = createStorageTools(storage, "scene_blocks/");
    const out = (await (tools.read as any).execute({ path: "a.md" }, {})) as string;
    expect(bytes(out)).toBeLessThanOrEqual(DEFAULT_READ_MAX_BYTES);
    expect(out).toContain("[truncated:");
  });

  it("still returns a small file verbatim", async () => {
    const storage = { readFile: async () => "small" } as any;
    const tools = createStorageTools(storage, "scene_blocks/");
    expect(await (tools.read as any).execute({ path: "a.md" }, {})).toBe("small");
  });
});
