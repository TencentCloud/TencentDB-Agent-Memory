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
} from "./index-db.js";

describe("index.db write durability", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("commits source ingest metadata even if a reader is still open", () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-index-"));
    dirs.push(dir);
    initIndexDb(dir);
    getReadDb("wiki-hold-reader", dir);

    const content = "# hello\n";
    expect(() => {
      withWriteDb(dir, (db) => {
        recordSourceIngestResult(db, {
          filename: "hello.md",
          sha256: sha256(content),
          size: Buffer.byteLength(content, "utf-8"),
          ok: true,
        });
      });
    }).not.toThrow();

    const rows = listSources(getReadDb("wiki-hold-reader-2", dir));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ingested");
  });
});
