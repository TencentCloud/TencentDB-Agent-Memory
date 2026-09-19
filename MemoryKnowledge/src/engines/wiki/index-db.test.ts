import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getReadDb,
  initIndexDb,
  listSources,
  recordSourceIngestResult,
  sha256,
  withWriteDb,
  evictWikiDb,
} from "./index-db.js";

describe("index.db write durability", () => {
  const dirs: string[] = [];

  afterEach(() => {
    evictWikiDb("wiki-reader");
    evictWikiDb("wiki-reader-after-write");
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("commits source metadata while a pooled reader is open", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-index-"));
    dirs.push(dir);
    initIndexDb(dir);
    getReadDb("wiki-reader", dir);

    const content = "# hello\n";
    expect(() => withWriteDb(dir, (db) => {
      recordSourceIngestResult(db, {
        filename: "hello.md",
        sha256: sha256(content),
        size: Buffer.byteLength(content, "utf8"),
        ok: true,
      });
    })).not.toThrow();

    expect(listSources(getReadDb("wiki-reader-after-write", dir))).toMatchObject([
      { filename: "hello.md", status: "ingested" },
    ]);
  });
});
