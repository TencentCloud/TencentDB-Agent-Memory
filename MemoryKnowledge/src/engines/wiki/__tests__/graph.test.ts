import { describe, expect, it } from "vitest";
import { resolveEdges } from "../manager.js";
import type { WikiPage } from "../types.js";

function page(id: string, overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    id,
    title: overrides.title ?? id,
    type: overrides.type ?? "concept",
    path: `/tmp/wiki/${id}.md`,
    relPath: `wiki/${id}.md`,
    content: overrides.content ?? "",
    sources: [],
    links: overrides.links ?? [],
    description: overrides.description,
  };
}

describe("resolveEdges", () => {
  it("resolves exact ids and page titles, dedupes repeated links", () => {
    const pages = [
      page("concepts/a", { title: "Alpha", links: ["concepts/b", "Beta", "beta", "concepts/b"] }),
      page("concepts/b", { title: "Beta", links: ["Concepts/A"] }),
    ];

    const { edges } = resolveEdges(pages);

    expect(edges).toEqual([
      { source: "concepts/a", target: "concepts/b" },
      { source: "concepts/b", target: "concepts/a" },
    ]);
  });

  it("counts unresolvable links and skips self-links", () => {
    const pages = [
      page("concepts/a", { title: "Alpha", links: ["concepts/a", "missing-page"] }),
      page("concepts/b", { title: "Beta" }),
    ];

    const { edges, brokenLinks } = resolveEdges(pages);

    expect(edges).toEqual([]);
    expect(brokenLinks).toBe(1);
  });

  it("ignores hidden page types when building edges", () => {
    const pages = [
      page("query/q1", { type: "query", links: ["concepts/a"] }),
      page("concepts/a", { title: "Alpha" }),
    ];

    const { edges } = resolveEdges(pages);

    expect(edges).toEqual([]);
  });

  it("reports orphan content pages but excludes structural pages", () => {
    const pages = [
      page("concepts/a", { title: "Alpha", links: ["concepts/b"] }),
      page("concepts/b", { title: "Beta" }),
      page("concepts/lonely", { title: "Lonely" }),
      page("index", { type: "index", title: "Index" }),
      page("purpose", { type: "purpose", title: "Purpose" }),
    ];

    const { orphanPages } = resolveEdges(pages);

    expect(orphanPages).toBe(1);
  });
});