import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { normalizeWikiPath, parseFileBlocks } from "../src/engines/wiki/ingest-v2/file-protocol.js";

const block = (path: string, content: string) =>
  `<<<FILE path="${path}">>>\n${content}\n<<<END>>>`;

it.each(["\ud800", "\udc00", "x\ud800y", "\ud800\ud800", "\udc00\ud800"])(
  "rejects malformed path and content %j", (bad) => {
    expect(normalizeWikiPath(`wiki/${bad}.md`)).toBeNull();
    const parsed = parseFileBlocks(block(`wiki/${bad}.md`, "body") + block("wiki/good.md", bad));
    expect(parsed.files).toEqual([]);
    expect(parsed.warnings).toHaveLength(2);
  },
);

it.each(["ASCII", "Zażółć", "\ufffd", "\ud83d\ude42", "\ud800\udc00", "\udbff\udfff"])(
  "preserves well-formed path and content %j", (text) => {
    const path = `wiki/${text}.md`;
    expect(normalizeWikiPath(path)).toBe(path);
    expect(parseFileBlocks(block(path, text))).toEqual({
      files: [{ path, content: `${text}\n` }], warnings: [],
    });
  },
);

it("continues after rejecting malformed text", () => {
  const parsed = parseFileBlocks(block("wiki/bad.md", "\ud800") + block("wiki/good.md", "ok"));
  expect(parsed.files).toEqual([{ path: "wiki/good.md", content: "ok\n" }]);
  expect(parsed.warnings).toHaveLength(1);
});

it("prevents a malformed filename from aliasing an existing replacement-character filename", () => {
  const dir = mkdtempSync(join(tmpdir(), "wiki-unicode-"));
  try {
    const existing = join(dir, "\ufffd.md");
    writeFileSync(existing, "existing");
    expect(readFileSync(join(dir, "\ud800.md"), "utf8")).toBe("existing");
    for (const file of parseFileBlocks(block("wiki/\ud800.md", "overwrite")).files) {
      writeFileSync(join(dir, file.path.slice(5)), file.content);
    }
    expect(readFileSync(existing, "utf8")).toBe("existing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
