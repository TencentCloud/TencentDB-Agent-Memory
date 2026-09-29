import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapPlan,
  buildManifest,
  hashContent,
  isPageFile,
  isStructuralPage,
  reconcile,
  wantedPages,
  wikiMoved,
} from "./wiki-sync-reconcile.js";
import { parseArgs, walkPageFiles } from "./wiki-sync.js";

const tempDirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-sync-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const map = (entries: Record<string, string>) => new Map(Object.entries(entries));
const manifestOf = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([p, c]) => [p, hashContent(c) as string]));

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

  it("treats schema.md and purpose.md as structural", () => {
    expect(isStructuralPage("wiki/schema.md")).toBe(true);
    expect(isStructuralPage("wiki/purpose.md")).toBe(true);
    expect(isStructuralPage("wiki/index.md")).toBe(false);
  });
});

describe("wantedPages", () => {
  it("de-duplicates, sorts, and drops structural files", () => {
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

describe("bootstrapPlan (first run)", () => {
  it("projects the wiki and removes checkout pages the wiki does not have", () => {
    const tdai = map({ "wiki/products/a/a.md": "# a", "wiki/products/new/new.md": "# new" });
    const plan = bootstrapPlan(tdai, [
      "wiki/products/a/a.md",
      "wiki/products/legacy/old.md",
      "wiki/media/keep.md",
      "wiki/schema.md",
    ]);

    expect(plan.toGit.write).toEqual(["wiki/products/a/a.md", "wiki/products/new/new.md"]);
    expect(plan.toGit.delete).toEqual(["wiki/products/legacy/old.md"]);
    // Nothing is imported from the checkout on the run that defines the baseline.
    expect(plan.toWiki).toEqual({ write: [], delete: [] });
    expect(plan.conflicts).toEqual([]);
  });
});

describe("reconcile (steady state)", () => {
  const base = { "wiki/a.md": "# a", "wiki/b.md": "# b" };

  it("does nothing when neither side moved", () => {
    const plan = reconcile({
      tdai: map(base),
      gitChanged: new Map(),
      manifest: manifestOf(base),
      gitContent: () => null,
    });
    expect(plan).toEqual({
      toGit: { write: [], delete: [] },
      toWiki: { write: [], delete: [] },
      conflicts: [],
      unmanaged: [],
    });
  });

  it("writes a wiki-only change into the checkout", () => {
    const plan = reconcile({
      tdai: map({ ...base, "wiki/a.md": "# a edited in wiki" }),
      gitChanged: new Map(),
      manifest: manifestOf(base),
      gitContent: () => null,
    });
    expect(plan.toGit.write).toEqual(["wiki/a.md"]);
    expect(plan.toWiki.write).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("removes the file for a page deleted in the wiki", () => {
    const plan = reconcile({
      tdai: map({ "wiki/b.md": "# b" }),
      gitChanged: new Map(),
      manifest: manifestOf(base),
      gitContent: () => null,
    });
    expect(plan.toGit.delete).toEqual(["wiki/a.md"]);
  });

  it("imports a git-only change into the wiki", () => {
    const plan = reconcile({
      tdai: map(base),
      gitChanged: new Map([["wiki/a.md", "modified"]]),
      manifest: manifestOf(base),
      gitContent: () => "# a edited in git",
    });
    expect(plan.toWiki.write).toEqual(["wiki/a.md"]);
    expect(plan.toGit.write).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("deletes the page for a file deleted in git", () => {
    const plan = reconcile({
      tdai: map(base),
      gitChanged: new Map([["wiki/a.md", "deleted"]]),
      manifest: manifestOf(base),
      gitContent: () => null,
    });
    expect(plan.toWiki.delete).toEqual(["wiki/a.md"]);
  });

  it("treats both-sides-moved-to-the-same-content as convergence, not conflict", () => {
    const plan = reconcile({
      tdai: map({ ...base, "wiki/a.md": "# same edit" }),
      gitChanged: new Map([["wiki/a.md", "modified"]]),
      manifest: manifestOf(base),
      gitContent: () => "# same edit",
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.toGit.write).toEqual([]);
    expect(plan.toWiki.write).toEqual([]);
  });

  it("refuses when both sides moved to different content", () => {
    const plan = reconcile({
      tdai: map({ ...base, "wiki/a.md": "# edited in wiki" }),
      gitChanged: new Map([["wiki/a.md", "modified"]]),
      manifest: manifestOf(base),
      gitContent: () => "# edited in git",
    });
    expect(plan.conflicts).toEqual(["wiki/a.md"]);
    expect(plan.toGit.write).toEqual([]);
    expect(plan.toWiki.write).toEqual([]);
  });

  it("never touches structural files, in either direction", () => {
    const plan = reconcile({
      tdai: map({ "wiki/schema.md": "# schema now" }),
      gitChanged: new Map([
        ["wiki/schema.md", "modified"],
        ["wiki/purpose.md", "modified"],
      ]),
      manifest: manifestOf({ "wiki/schema.md": "# schema", "wiki/purpose.md": "# purpose" }),
      gitContent: () => "# whatever",
    });
    expect(plan.toGit).toEqual({ write: [], delete: [] });
    expect(plan.toWiki).toEqual({ write: [], delete: [] });
    expect(plan.conflicts).toEqual([]);
  });

  it("reports a changed path outside wiki/ instead of acting on it", () => {
    const plan = reconcile({
      tdai: map(base),
      gitChanged: new Map([["docs/notes.md", "modified"]]),
      manifest: manifestOf(base),
      gitContent: () => null,
    });
    expect(plan.unmanaged).toEqual(["docs/notes.md"]);
    expect(plan.toGit).toEqual({ write: [], delete: [] });
    expect(plan.toWiki).toEqual({ write: [], delete: [] });
  });
});

describe("wikiMoved", () => {
  it("reports additions, edits and deletions against the manifest", () => {
    const moved = wikiMoved(map({ "wiki/a.md": "# a edited", "wiki/new.md": "# new" }), manifestOf({ "wiki/a.md": "# a", "wiki/gone.md": "# gone" }));
    expect([...moved].sort()).toEqual(["wiki/a.md", "wiki/gone.md", "wiki/new.md"]);
  });

  it("is empty when nothing changed", () => {
    expect([...wikiMoved(map({ "wiki/a.md": "# a" }), manifestOf({ "wiki/a.md": "# a" }))]).toEqual([]);
  });
});

describe("buildManifest", () => {
  it("hashes managed pages only", () => {
    const manifest = buildManifest(map({ "wiki/a.md": "# a", "wiki/schema.md": "# s", "wiki/media/m.md": "# m" }));
    expect([...manifest.keys()]).toEqual(["wiki/a.md"]);
  });
});

describe("walkPageFiles", () => {
  it("lists wiki markdown, skipping media and non-markdown", () => {
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

  it("rejects an unknown conflict policy", () => {
    expect(() => parseArgs(["--repo", "/r", "--wiki-id", "w", "--on-conflict", "maybe"])).toThrow(
      /--on-conflict/,
    );
  });

  it("defaults to aborting on conflict, reading env fallbacks, and parsing booleans", () => {
    const prev = process.env.KNOWLEDGE_SERVICE_ID;
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
        onConflict: "abort",
        push: true,
        dryRun: true,
        noCommit: false,
      });
    } finally {
      if (prev === undefined) delete process.env.KNOWLEDGE_SERVICE_ID;
      else process.env.KNOWLEDGE_SERVICE_ID = prev;
    }
  });
});