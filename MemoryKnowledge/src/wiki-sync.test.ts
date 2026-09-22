import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isPageFile, parseArgs, planSync, walkPageFiles, wantedPages } from "./wiki-sync.js";

const tempDirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-sync-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isPageFile", () => {
  it("accepts markdown under wiki/", () => {
    expect(isPageFile("wiki/products/adlc/adlc.md")).toBe(true);
  });

  it("rejects traversal, non-markdown, and foreign trees", () => {
    expect(isPageFile("wiki/../../etc/passwd.md")).toBe(false);
    expect(isPageFile("wiki/products/adlc/adlc.png")).toBe(false);
    expect(isPageFile("docs/adlc.md")).toBe(false);
    expect(isPageFile("README.md")).toBe(false);
  });

  it("excludes the media subtree, which page/ls never lists", () => {
    expect(isPageFile("wiki/media/diagram.md")).toBe(false);
  });
});

describe("wantedPages", () => {
  it("de-duplicates, sorts, and drops service-generated structural files", () => {
    const pages = [
      "wiki/products/b/b.md",
      "wiki/schema.md",
      "wiki/purpose.md",
      "wiki/products/a/a.md",
      "wiki/products/b/b.md",
    ];
    expect(wantedPages(pages)).toEqual(["wiki/products/a/a.md", "wiki/products/b/b.md"]);
  });
});

describe("planSync", () => {
  it("writes the wiki's pages and deletes only page files with no counterpart", () => {
    const existing = [
      "wiki/products/a/a.md",
      "wiki/products/gone/gone.md",
      "wiki/media/keep.md",
      "README.md",
      ".github/workflows/ci.yml",
    ];
    const plan = planSync(["wiki/products/a/a.md", "wiki/products/new/new.md"], existing);

    expect(plan.write).toEqual(["wiki/products/a/a.md", "wiki/products/new/new.md"]);
    expect(plan.delete).toEqual(["wiki/products/gone/gone.md"]);
  });

  it("never plans a deletion for a structurally excluded page", () => {
    expect(planSync([], ["wiki/schema.md"]).delete).toEqual([]);
  });
});

describe("walkPageFiles", () => {
  it("lists wiki markdown, skips media and non-markdown", () => {
    const repo = tempRepo();
    mkdirSync(join(repo, "wiki/products/a"), { recursive: true });
    mkdirSync(join(repo, "wiki/media"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "wiki/products/a/a.md"), "# a");
    writeFileSync(join(repo, "wiki/media/diagram.md"), "asset");
    writeFileSync(join(repo, "wiki/products/a/a.png"), "img");
    writeFileSync(join(repo, "docs/note.md"), "not a page");

    expect(walkPageFiles(repo)).toEqual(["wiki/products/a/a.md"]);
  });

  it("returns nothing when the wiki tree does not exist", () => {
    expect(walkPageFiles(tempRepo())).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("requires --wiki-id and --repo", () => {
    expect(() => parseArgs([])).toThrow(/--repo/);
    expect(() => parseArgs(["--repo", "/tmp/r"])).toThrow(/--wiki-id/);
  });

  it("defaults the api url, reads env fallbacks, and parses booleans", () => {
    const env = { ...process.env };
    process.env.KNOWLEDGE_SERVICE_ID = "svc-1";
    try {
      const opts = parseArgs([
        "--repo",
        "/tmp/r",
        "--wiki-id",
        "wiki-x",
        "--api-url",
        "http://ks:8421",
        "--push",
        "--dry-run",
      ]);
      expect(opts).not.toBe("help");
      if (opts === "help") return;
      expect(opts).toMatchObject({
        repo: "/tmp/r",
        wikiId: "wiki-x",
        apiUrl: "http://ks:8421",
        serviceId: "svc-1",
        push: true,
        dryRun: true,
        noCommit: false,
      });
    } finally {
      if (env.KNOWLEDGE_SERVICE_ID === undefined) delete process.env.KNOWLEDGE_SERVICE_ID;
      else process.env.KNOWLEDGE_SERVICE_ID = env.KNOWLEDGE_SERVICE_ID;
    }
  });
});