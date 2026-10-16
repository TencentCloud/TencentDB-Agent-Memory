import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndexFile, renderIndex } from "./index-builder.js";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const path of temporaryProjects.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("wiki index links", () => {
  it("encodes filename delimiters while preserving directory separators", () => {
    const text = renderIndex([
      { title: "Request", relPath: "/sources/HTTP Request #1? (draft) %.md", description: "", type: "source" },
    ]);
    expect(text).toContain("* [Request](/sources/HTTP%20Request%20%231%3F%20%28draft%29%20%25.md)");
  });

  it("escapes brackets and backslashes in link labels", () => {
    const text = renderIndex([
      { title: "Array]index [and \\path", relPath: "/array.md", description: "", type: "concept" },
    ]);
    expect(text).toContain("* [Array\\]index \\[and \\\\path](/array.md)");
  });

  it("creates encoded links for actual nested wiki files", () => {
    const project = mkdtempSync(join(tmpdir(), "wiki-index-links-"));
    temporaryProjects.push(project);
    const wiki = join(project, "wiki");
    mkdirSync(join(wiki, "sources"), { recursive: true });
    writeFileSync(join(wiki, "sources", "HTTP Request #1.md"), '---\ntitle: "Request [v1]"\ntype: source\ndescription: Protocol reference\n---\nBody\n');
    expect(rebuildIndexFile(project)).toBe(1);
    expect(readFileSync(join(wiki, "index.md"), "utf8")).toContain(
      "* [Request \\[v1\\]](/sources/HTTP%20Request%20%231.md) - Protocol reference",
    );
  });

  it("retains existing simple links, descriptions and grouping", () => {
    expect(renderIndex([
      { title: "Alpha", relPath: "/sources/alpha.md", description: "First source", type: "source" },
    ])).toBe("# Index\n\n## Sources\n\n* [Alpha](/sources/alpha.md) - First source\n");
  });
});
