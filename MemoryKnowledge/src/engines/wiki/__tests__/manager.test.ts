import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWikiSourceManager } from "../manager.js";
import { buildPage } from "../ingest-v2/frontmatter.js";

describe("createWikiSourceManager", () => {
  it("fills Louvain communities and graph stats", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-mgr-"));
    const dataDir = mkdtempSync(join(tmpdir(), "wiki-data-"));
    const concepts = join(root, "wiki", "concepts");
    mkdirSync(concepts, { recursive: true });
    writeFileSync(
      join(concepts, "a.md"),
      buildPage({ type: "concept", title: "Alpha" }, "See [[concepts/b]] and [[missing]]."),
    );
    writeFileSync(
      join(concepts, "b.md"),
      buildPage({ type: "concept", title: "Beta" }, "See [[concepts/a]]."),
    );
    writeFileSync(join(concepts, "c.md"), buildPage({ type: "concept", title: "Gamma" }, "No links."));

    const mgr = createWikiSourceManager(dataDir);
    try {
      const state = mgr.register({ name: "w", path: root });

      expect(state.graphStats).toEqual({ pages: 3, edges: 2, brokenLinks: 1, orphanPages: 1 });

      const g = mgr.graph("w");
      expect(g.nodes).toHaveLength(3);
      expect(g.communities.reduce((n, c) => n + c.nodeCount, 0)).toBe(3);
      const community = (id: string) => g.nodes.find((node) => node.id === id)!.community;
      expect(community("concepts/a")).toBe(community("concepts/b"));
    } finally {
      mgr.remove("w");
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});