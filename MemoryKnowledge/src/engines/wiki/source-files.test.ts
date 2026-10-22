import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findWikiSourceFiles } from "./source-files.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "wiki-source-files-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("findWikiSourceFiles", () => {
  it("matches the upload extension contract case-insensitively", async () => {
    const dir = await makeTempDir();
    const nested = path.join(dir, "nested");
    await mkdir(nested, { recursive: true });
    await Promise.all([
      writeFile(path.join(dir, "README.MD"), "A", "utf-8"),
      writeFile(path.join(dir, "Guide.markdown"), "B", "utf-8"),
      writeFile(path.join(dir, "Notes.TXT"), "C", "utf-8"),
      writeFile(path.join(nested, "Doc.Markdown"), "D", "utf-8"),
      writeFile(path.join(dir, "ignored.pdf"), "E", "utf-8"),
    ]);

    const files = findWikiSourceFiles(dir)
      .map((file) => path.relative(dir, file).replace(/\\/g, "/"))
      .sort();

    expect(files).toEqual([
      "Guide.markdown",
      "Notes.TXT",
      "README.MD",
      "nested/Doc.Markdown",
    ]);
  });
});
